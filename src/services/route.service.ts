// route.service.ts
import axios, { type AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import throttle from 'lodash/throttle';
import type { FeatureCollection as GeoJSONFeatureCollection, LineString as GeoJSONLineString, Feature as GeoJSONFeature, GeoJsonProperties } from 'geojson';
import type { OrsFeatureCollection } from '@/types';

export type Coord = [number, number];
// BearingValue can be a simple [angle, tolerance], a complex [[approachAngle, approachTolerance], [departureAngle, departureTolerance]], or null
export type BearingValue = [number, number] | [[number, number], [number, number]] | null;

// SimpleBearing is specifically [angleDegrees, toleranceDegrees]
type SimpleBearing = [number, number];

const ors: AxiosInstance = axios.create({
  baseURL: 'https://api.openrouteservice.org',
  headers: { Authorization: import.meta.env.VITE_ORS_API_KEY },
  timeout: 10000,
});

axiosRetry(ors, {
  retries: 3,
  retryDelay: (retryCount, error) => {
    if (error.response && error.response.status === 429 && error.response.headers['retry-after']) {
      const retryAfterSeconds = parseInt(error.response.headers['retry-after'], 10);
      console.warn(`[RouteService] ORS Rate Limit: Retrying after ${retryAfterSeconds} seconds.`);
      return retryAfterSeconds * 1000;
    }
    return axiosRetry.exponentialDelay(retryCount, error, 1000);
  },
  retryCondition: (error) => {
    return (
      axiosRetry.isNetworkOrIdempotentRequestError(error) ||
      error.response?.status === 429 ||
      error.response?.status === 502 ||
      error.response?.status === 503 ||
      error.response?.status === 504
    );
  },
});

const routeCache = new Map<string, any>();

// Define this at a scope accessible to functions that might need it, or pass as param.
const defaultWideBearingForORS: SimpleBearing = [0, 180]; // [angle, tolerance]

function handleOrsError(error: any, context: string): never {
  console.error(`[RouteService] Error in ${context}:`, error.isAxiosError ? error.toJSON() : error);
  if (error.response && error.response.data) {
    console.error(`[RouteService] ORS Error Response Data for ${context}:`, error.response.data);
    let orsErrorMessage = 'Unknown ORS error';
    const status = error.response.status || 'N/A';
    const errorData = error.response.data.error;

    if (errorData) {
      if (typeof errorData === 'string') {
        orsErrorMessage = errorData;
      } else if (errorData.message) {
        orsErrorMessage = errorData.message;
        if (errorData.details) {
          orsErrorMessage += ` Details: ${JSON.stringify(errorData.details)}`;
        }
      } else if (typeof errorData === 'object') {
        const errorCode = errorData.code;
        const errorDetailsString = JSON.stringify(errorData);
        orsErrorMessage = errorCode ? `Error code ${errorCode}: ${errorDetailsString}` : errorDetailsString;
      }
    } else if (error.response.data.message && typeof error.response.data.message === 'string') {
      orsErrorMessage = error.response.data.message;
    } else if (typeof error.response.data === 'string') {
      orsErrorMessage = error.response.data;
    }
    throw new Error(`ORS API Error in ${context} (Status ${status}): ${orsErrorMessage}`);
  } else if (error.request) {
    throw new Error(`ORS API Error in ${context}: No response received. ${error.message}`);
  }
  throw error;
}

async function fetchLeg(coords: Coord[], options?: { atStart?: SimpleBearing; atEnd?: SimpleBearing; radiuses?: number[] }): Promise<OrsFeatureCollection> {
  const plainCoords = JSON.parse(JSON.stringify(coords)) as Coord[];
  const plainRadiuses = options?.radiuses ? (JSON.parse(JSON.stringify(options.radiuses)) as number[]) : undefined;

  const requestBody: {
    coordinates: Coord[];
    bearings?: (SimpleBearing | null)[];
    radiuses?: number[];
    instructions?: boolean;
    preference?: string;
  } = {
    coordinates: plainCoords,
    instructions: false,
    // No preference set, to use ORS default unless bearings issue forces "shortest"
  };

  if (plainRadiuses && plainRadiuses.length === plainCoords.length) {
    requestBody.radiuses = plainRadiuses;
  }

  if (options && (options.atStart || options.atEnd)) {
    const bArr: (SimpleBearing | null)[] = plainCoords.map(() => null);
    if (options.atStart && bArr.length > 0) {
      bArr[0] = options.atStart;
    } else if (bArr.length > 0) {
      // If atStart is not provided but array exists, ensure it's explicitly null or default
      bArr[0] = defaultWideBearingForORS; // Or null, if fetchLeg's caller ensures this logic
    }

    if (options.atEnd && bArr.length > 0) {
      bArr[bArr.length - 1] = options.atEnd;
    } else if (bArr.length > 0) {
      // If atEnd is not provided
      bArr[bArr.length - 1] = defaultWideBearingForORS; // Or null
    }
    // This logic needs to be robust: if atStart/atEnd is explicitly null, what should happen?
    // The current implementation of getRouteWithStickyShaping ALWAYS provides a non-null SimpleBearing for atStart/atEnd of legs.
    // So, the bArr construction here based on options might be fine as is if options always contain valid bearings when provided.
    // For safety, let's ensure bArr matches coordinate length and applies defaults if a specific option is missing but implied.
    // Re-simplifying: getRouteWithStickyShaping calls this with defined bearings.
    // If called elsewhere, it needs to be robust. For now, assume options.atStart/atEnd are valid SimpleBearings if provided.

    const finalBearingsForLeg: (SimpleBearing | null)[] = new Array(plainCoords.length).fill(null);
    if (plainCoords.length > 0) {
      finalBearingsForLeg[0] = options.atStart || defaultWideBearingForORS;
      if (plainCoords.length > 1) {
        finalBearingsForLeg[plainCoords.length - 1] = options.atEnd || defaultWideBearingForORS;
      } else {
        // Single point leg, apply start bearing if also end
        finalBearingsForLeg[0] = options.atStart || options.atEnd || defaultWideBearingForORS;
      }
    }

    if (finalBearingsForLeg.some((b) => b !== null)) {
      // Check if any bearing is actually set
      requestBody.bearings = finalBearingsForLeg.map((b) => (b ? [b[0], b[1]] : null)); // Ensure it's SimpleBearing or null
    }
  }
  // console.log(`[RouteService] fetchLeg - Request Body:`, JSON.stringify(requestBody).substring(0, 300) + "...");

  try {
    const response = await ors.post<OrsFeatureCollection>('/v2/directions/cycling-road/geojson', requestBody);
    console.log(`[RouteService] fetchLeg for coords ${JSON.stringify(coords)} - ORS response status: ${response.status}`);
    return response.data;
  } catch (error) {
    return handleOrsError(error, `WorkspaceLeg for coords ${JSON.stringify(coords)}`);
  }
}

export async function getRouteWithStickyShaping(
  startCoord: Coord,
  shapingPointCoord: Coord,
  endCoord: Coord,
  shapingPointBearing: SimpleBearing, // This is a non-null SimpleBearing
  startRadius: number = 25,
  shapingPointRadius: number = 7,
  endRadius: number = 25
): Promise<OrsFeatureCollection> {
  console.log(`[RouteService] getRouteWithStickyShaping. SP_Coord: ${shapingPointCoord}, SP_Bearing: ${shapingPointBearing}`);

  // For leg A (start to shapingPoint), the shapingPointBearing is the arrival bearing at the shapingPoint
  const legAData = await fetchLeg([startCoord, shapingPointCoord], { atEnd: shapingPointBearing, radiuses: [startRadius, shapingPointRadius] });

  // For leg B (shapingPoint to end), the shapingPointBearing is the departure bearing from the shapingPoint
  const legBData = await fetchLeg([shapingPointCoord, endCoord], { atStart: shapingPointBearing, radiuses: [shapingPointRadius, endRadius] });

  const legAFeature = legAData.features?.[0] as GeoJSONFeature<GeoJSONLineString, any> | undefined;
  const legBFeature = legBData.features?.[0] as GeoJSONFeature<GeoJSONLineString, any> | undefined;

  if (!legAFeature?.geometry || !legBFeature?.geometry) {
    console.error('[RouteService] getRouteWithStickyShaping: One or both legs failed to return valid geometry.');
    throw new Error('Failed to calculate one or both route legs for sticky shaping.');
  }

  const coordsA = legAFeature.geometry.coordinates as Coord[];
  // Ensure coordsB doesn't duplicate the shaping point if ORS includes it in both leg geometries
  const coordsB = (legBFeature.geometry.coordinates as Coord[]).length > 0 ? (legBFeature.geometry.coordinates as Coord[]).slice(1) : [];

  const mergedCoords: Coord[] = [...coordsA, ...coordsB];

  const legASummary = legAFeature.properties?.summary || { distance: 0, duration: 0 };
  const legBSummary = legBFeature.properties?.summary || { distance: 0, duration: 0 };
  const mergedSummary = {
    distance: legASummary.distance + legBSummary.distance,
    duration: legASummary.duration + legBSummary.duration,
  };

  const finalMergedFeatureProperties: GeoJsonProperties = {
    summary: mergedSummary,
    way_points: [
      [0, 0],
      [1, coordsA.length - 1],
      [2, mergedCoords.length - 1],
    ],
  };

  const finalMergedFeature: GeoJSONFeature<GeoJSONLineString, any> = {
    type: 'Feature',
    properties: finalMergedFeatureProperties,
    geometry: {
      type: 'LineString',
      coordinates: mergedCoords,
    },
  };

  const finalFeatureCollection: OrsFeatureCollection = {
    type: 'FeatureCollection',
    features: [finalMergedFeature],
    bbox:
      legAData.bbox && legBData.bbox
        ? [
            Math.min(legAData.bbox[0], legBData.bbox[0]),
            Math.min(legAData.bbox[1], legBData.bbox[1]),
            Math.max(legAData.bbox[2], legBData.bbox[2]),
            Math.max(legAData.bbox[3], legBData.bbox[3]),
          ]
        : undefined,
    metadata: legAData.metadata,
  };

  console.log('[RouteService] getRouteWithStickyShaping - Merged route calculated.');
  return finalFeatureCollection;
}

export async function getRoute(coordinates: Coord[], radiuses?: number[], bearings?: BearingValue[]): Promise<OrsFeatureCollection> {
  const plainCoordinates = JSON.parse(JSON.stringify(coordinates)) as Coord[];
  const plainRadiuses = radiuses ? (JSON.parse(JSON.stringify(radiuses)) as number[]) : undefined;
  const plainBearingsInput = bearings ? (JSON.parse(JSON.stringify(bearings)) as BearingValue[]) : undefined;

  let filteredBearingsForRequest: (SimpleBearing | null)[] | undefined = undefined;
  let hasMeaningfulBearingsToSend = false;

  if (plainBearingsInput && plainBearingsInput.length === plainCoordinates.length) {
    filteredBearingsForRequest = plainBearingsInput.map((bearingInput, index, arr) => {
      // Process only for the absolute start (index 0) and absolute end (index arr.length - 1)
      if (index === 0 || index === arr.length - 1) {
        if (Array.isArray(bearingInput) && typeof bearingInput[0] === 'number' && typeof bearingInput[1] === 'number' && bearingInput.length === 2) {
          return bearingInput as SimpleBearing; // It's a valid SimpleBearing
        } else if (bearingInput === null) {
          // If the input bearing for a start/end point was null, replace it with the default wide bearing.
          return defaultWideBearingForORS;
        }
        // Fallback for unexpected formats at start/end (e.g., complex [[in,out],[in,out]])
        console.warn(`[RouteService] getRoute: Bearing at start/end index ${index} has unexpected format, using default. Received:`, bearingInput);
        return defaultWideBearingForORS; // Use default wide bearing
      }
      return null; // Intermediate bearings are explicitly nullified as per existing logic in getRoute
    });
    // Check if any bearing in the filtered list is not null
    hasMeaningfulBearingsToSend = filteredBearingsForRequest.some((b) => b !== null);
  }

  const cacheKeyObject: {
    coordinates: Coord[];
    radiuses?: number[];
    bearings?: (SimpleBearing | null)[]; // Cache key should use the bearings that will be sent
  } = { coordinates: plainCoordinates };

  if (plainRadiuses) {
    cacheKeyObject.radiuses = plainRadiuses;
  }
  // Only add bearings to cache key if they are actually being sent and are meaningful
  if (hasMeaningfulBearingsToSend && filteredBearingsForRequest) {
    cacheKeyObject.bearings = filteredBearingsForRequest;
  }
  const key = JSON.stringify(cacheKeyObject);

  if (routeCache.has(key)) {
    console.log('[RouteService] Returning cached route for key:', key.substring(0, 100) + '...');
    return Promise.resolve(routeCache.get(key));
  }

  const fetchRouteInner = async () => {
    console.log(
      '[RouteService] getRoute (single call) - Fetching. Coordinates:',
      plainCoordinates.length,
      plainCoordinates,
      'Radiuses:',
      plainRadiuses ? plainRadiuses.length : 'N/A',
      plainRadiuses,
      ...(hasMeaningfulBearingsToSend && filteredBearingsForRequest
        ? ['Bearings (for ORS request):', filteredBearingsForRequest.length, filteredBearingsForRequest]
        : ['Bearings: Not sent or all nullified by filter'])
    );

    const requestBody: {
      coordinates: Coord[];
      radiuses?: number[];
      bearings?: (SimpleBearing | null)[]; // ORS expects array of [value,deviation] or nulls
      extra_info?: string[];
      instructions?: boolean;
      // preference?: string; // Ensure no preference is set to use ORS default
    } = {
      coordinates: plainCoordinates,
      instructions: false,
    };

    if (plainRadiuses) {
      requestBody.radiuses = plainRadiuses;
    }
    if (hasMeaningfulBearingsToSend && filteredBearingsForRequest) {
      requestBody.bearings = filteredBearingsForRequest;
    }

    try {
      console.log('[RouteService] getRoute (single call) - Request Body to ORS:', JSON.stringify(requestBody, null, 2).substring(0, 500) + '...');
      const response = await ors.post<OrsFeatureCollection>('/v2/directions/cycling-road/geojson', requestBody);
      console.log('[RouteService] getRoute (single call) - ORS response status:', response.status);
      routeCache.set(key, response.data); // Cache the successful response
      return response.data;
    } catch (error) {
      return handleOrsError(error, 'getRoute (single call)');
    }
  };

  // Throttling to prevent rapid identical requests.
  // Note: If params change slightly but key remains same due to stringify order, this throttle keying might be imperfect.
  // However, for distinct requests (different keys), it correctly throttles separate API calls.
  const throttledFetchRouteInner = throttle(fetchRouteInner, 1000, {
    leading: true, // Fire on the leading edge of the timeout
    trailing: false, // Do not fire on the trailing edge
  });

  // For direct calls (like tests), you might want to bypass throttle or use fetchRouteInner directly
  // For now, all calls go through throttle.
  return throttledFetchRouteInner();
}

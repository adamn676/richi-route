// route.service.ts
import axios, { type AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import throttle from 'lodash/throttle';
import type {
  FeatureCollection as GeoJSONFeatureCollection,
  LineString as GeoJSONLineString,
  Feature as GeoJSONFeature,
  GeoJsonProperties, // Import GeoJsonProperties
} from 'geojson';
import type { OrsFeatureCollection } from '@/types'; // Assuming you'll move OrsFeatureCollection to src/types/index.ts

// Keep original Coord and BearingValue types
export type Coord = [number, number];
export type BearingValue = [number, number] | [[number, number], [number, number]] | null;

// Simplified bearing type for the new two-leg strategy
type SimpleBearing = [number, number]; // [angleDegrees, toleranceDegrees]

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

// Helper: fetch a single leg, applying bearing only at its start or end OF THIS LEG
async function fetchLeg(coords: Coord[], options?: { atStart?: SimpleBearing; atEnd?: SimpleBearing; radiuses?: number[] }): Promise<OrsFeatureCollection> {
  const plainCoords = JSON.parse(JSON.stringify(coords)) as Coord[];
  const plainRadiuses = options?.radiuses ? (JSON.parse(JSON.stringify(options.radiuses)) as number[]) : undefined;

  const requestBody: {
    coordinates: Coord[];
    bearings?: (SimpleBearing | null)[];
    radiuses?: number[];
    instructions?: boolean; // Recommended to set to false for legs if not using turn-by-turn for legs
    preference?: string; // e.g. "recommended" or "shortest"
  } = {
    coordinates: plainCoords,
    instructions: false, // Often not needed for intermediate leg calculations
    // preference: "recommended"
  };

  if (plainRadiuses && plainRadiuses.length === plainCoords.length) {
    requestBody.radiuses = plainRadiuses;
  }

  if (options && (options.atStart || options.atEnd)) {
    const bArr: (SimpleBearing | null)[] = plainCoords.map(() => null);
    if (options.atStart && bArr.length > 0) bArr[0] = options.atStart;
    if (options.atEnd && bArr.length > 0) bArr[bArr.length - 1] = options.atEnd;

    if (bArr.some((b) => b !== null)) {
      requestBody.bearings = bArr;
    }
  }
  // console.log(`[RouteService] fetchLeg - Request Body:`, JSON.stringify(requestBody).substring(0, 300) + "...");

  try {
    // Note: Consider not caching individual legs if they are always part of a larger, unique operation
    // or ensure cache keys for legs are very specific if leg caching is desired.
    const response = await ors.post<OrsFeatureCollection>('/v2/directions/cycling-regular/geojson', requestBody);
    console.log(`[RouteService] fetchLeg for coords ${JSON.stringify(coords)} - ORS response status: ${response.status}`);
    return response.data;
  } catch (error) {
    return handleOrsError(error, `WorkspaceLeg for coords ${JSON.stringify(coords)}`);
  }
}

// High-level API: get a “sticky” shaping route for ONE shaping point between two anchors
export async function getRouteWithStickyShaping(
  startCoord: Coord,
  shapingPointCoord: Coord,
  endCoord: Coord,
  shapingPointBearing: SimpleBearing,
  startRadius: number = 25,
  shapingPointRadius: number = 7,
  endRadius: number = 25
): Promise<OrsFeatureCollection> {
  console.log(`[RouteService] getRouteWithStickyShaping. SP_Coord: ${shapingPointCoord}, SP_Bearing: ${shapingPointBearing}`);

  const legAData = await fetchLeg([startCoord, shapingPointCoord], { atEnd: shapingPointBearing, radiuses: [startRadius, shapingPointRadius] });

  const legBData = await fetchLeg([shapingPointCoord, endCoord], { atStart: shapingPointBearing, radiuses: [shapingPointRadius, endRadius] });

  const legAFeature = legAData.features?.[0] as GeoJSONFeature<GeoJSONLineString, any> | undefined;
  const legBFeature = legBData.features?.[0] as GeoJSONFeature<GeoJSONLineString, any> | undefined;

  if (!legAFeature?.geometry || !legBFeature?.geometry) {
    console.error('[RouteService] getRouteWithStickyShaping: One or both legs failed to return valid geometry.');
    throw new Error('Failed to calculate one or both route legs for sticky shaping.');
  }

  const coordsA = legAFeature.geometry.coordinates as Coord[];
  const coordsB = (legBFeature.geometry.coordinates as Coord[]).slice(1);
  const mergedCoords: Coord[] = [...coordsA, ...coordsB];

  const legASummary = legAFeature.properties?.summary || { distance: 0, duration: 0 };
  const legBSummary = legBFeature.properties?.summary || { distance: 0, duration: 0 };
  const mergedSummary = {
    distance: legASummary.distance + legBSummary.distance,
    duration: legASummary.duration + legBSummary.duration,
  };

  // For simplicity, segments and extras are not deeply merged here.
  // A production app would need to handle this more robustly if turn-by-turn or detailed extras are needed.
  const finalMergedFeatureProperties: GeoJsonProperties = {
    summary: mergedSummary,
    // segments: [...(legAFeature.properties?.segments || []), ...(legBFeature.properties?.segments || [])], // Simplified
    // extras: { ...(legAFeature.properties?.extras || {}), ...(legBFeature.properties?.extras || {}) }, // Simplified
  };
  // Add way_points if ORS provides them and if they are useful.
  // The way_points for legA and legB would refer to indices within those legs.
  // Merging them requires re-calculating indices based on the new mergedCoords length.
  // Example: legA way_points: [[0,0],[1,10]]. legB way_points: [[0,0],[1,5]] (becomes [[1,10],[2,15]] after merge if legA had 11 coords)
  // For simplicity, let's reconstruct a basic way_points if possible, or omit.
  // ORS provides way_points like: "way_points":[[0,0],[10,1]] means original coord 0 is at geometry index 0, original coord 1 is at geometry index 10.
  // We can take way_points from legA, and for legB, add coordsA.length-1 to the geometry index of legB's way_points.
  // And adjust original coordinate index for legB way_points.
  // This part is tricky, for now, let's assign simple way_points for the merged feature
  finalMergedFeatureProperties.way_points = [
    [0, 0], // Start of Leg A
    [1, coordsA.length - 1], // End of Leg A (Shaping Point)
    [2, mergedCoords.length - 1], // End of Leg B
  ];

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
    metadata: legAData.metadata, // Assuming metadata from the first leg is sufficient or representative
  };

  console.log('[RouteService] getRouteWithStickyShaping - Merged route calculated.');
  return finalFeatureCollection;
}

// Existing getRoute function - this will be used for non-sticky scenarios or full route recalculations
export async function getRoute(coordinates: Coord[], radiuses?: number[], bearings?: BearingValue[]): Promise<OrsFeatureCollection> {
  const plainCoordinates = JSON.parse(JSON.stringify(coordinates)) as Coord[];
  const plainRadiuses = radiuses ? (JSON.parse(JSON.stringify(radiuses)) as number[]) : undefined;
  const plainBearingsInput = bearings ? (JSON.parse(JSON.stringify(bearings)) as BearingValue[]) : undefined;

  let filteredBearingsForRequest: (SimpleBearing | null)[] | undefined = undefined;
  let hasMeaningfulBearingsToSend = false;

  if (plainBearingsInput && plainBearingsInput.length === plainCoordinates.length) {
    filteredBearingsForRequest = plainBearingsInput.map((bearing, index, arr) => {
      // Only allow non-null bearings at absolute start (idx 0) or end (idx arr.length-1)
      if (index === 0 || index === arr.length - 1) {
        // Ensure it's SimpleBearing format [val, range] or null
        if (Array.isArray(bearing) && typeof bearing[0] === 'number' && typeof bearing[1] === 'number' && bearing.length === 2) {
          return bearing as SimpleBearing; // It's already a SimpleBearing
        } else if (bearing === null) {
          return null;
        }
        // If it's the nested [[arr],[dep]] format for start/end, ORS might also error here.
        // For simplicity, this generic getRoute assumes start/end bearings are already SimpleBearing or null.
        // Or, if it was a nested array, it would be invalid here based on SimpleBearing | null.
        console.warn(`[RouteService] getRoute: Bearing at start/end index ${index} has unexpected format, nullifying:`, bearing);
        return null;
      }
      return null; // Intermediate bearings are nullified
    });
    hasMeaningfulBearingsToSend = filteredBearingsForRequest.some((b) => b !== null);
  }

  const cacheKeyObject: {
    coordinates: Coord[];
    radiuses?: number[];
    bearings?: (SimpleBearing | null)[];
  } = { coordinates: plainCoordinates };

  if (plainRadiuses) {
    cacheKeyObject.radiuses = plainRadiuses;
  }
  if (hasMeaningfulBearingsToSend && filteredBearingsForRequest) {
    cacheKeyObject.bearings = filteredBearingsForRequest;
  }
  const key = JSON.stringify(cacheKeyObject);

  if (routeCache.has(key) && !hasMeaningfulBearingsToSend) {
    // Avoid cache if meaningful bearings were intended but then stripped, to re-fetch without. Or adjust cache key logic.
    // For now, let's simplify: if a meaningful bearing was stripped leading to "Not Sent", we might want to re-fetch rather than use a cache key that didn't include it.
    // This cache logic might need refinement if this getRoute is called in very quick succession with bearings that get stripped vs not.
    // A simpler cache key (just coords and radiuses if bearings are stripped) might be better.
    // However, if filteredBearingsForRequest is used in the key, it's accurate.
    console.log('[RouteService] Returning cached route for key:', key);
    return Promise.resolve(routeCache.get(key));
  }

  const fetchRouteInner = async () => {
    console.log(
      '[RouteService] getRoute (single call) - Fetching. Coordinates:',
      plainCoordinates,
      'Radiuses:',
      plainRadiuses,
      ...(hasMeaningfulBearingsToSend && filteredBearingsForRequest
        ? ['Bearings (filtered for start/end):', filteredBearingsForRequest]
        : ['Bearings: Not sent'])
    );

    const requestBody: {
      coordinates: Coord[];
      radiuses?: number[];
      bearings?: (SimpleBearing | null)[];
      extra_info?: string[];
      instructions?: boolean;
      preference?: string;
    } = {
      coordinates: plainCoordinates,
      instructions: false, // Example
    };

    if (plainRadiuses) {
      requestBody.radiuses = plainRadiuses;
    }
    if (hasMeaningfulBearingsToSend && filteredBearingsForRequest) {
      requestBody.bearings = filteredBearingsForRequest;
    }

    try {
      const response = await ors.post<OrsFeatureCollection>('/v2/directions/cycling-regular/geojson', requestBody);
      console.log('[RouteService] getRoute (single call) - ORS response status:', response.status);
      if (!hasMeaningfulBearingsToSend || (filteredBearingsForRequest && filteredBearingsForRequest.every((b) => b === null))) {
        // Cache only if no meaningful bearings were sent, or if all bearings ended up null
        // This prevents caching a "no-bearing" route for a key that might later imply bearings.
        // The cache key already handles this by including the filtered bearings.
        routeCache.set(key, response.data);
      }
      return response.data;
    } catch (error) {
      return handleOrsError(error, 'getRoute (single call)');
    }
  };

  const throttledFetchRouteInner = throttle(fetchRouteInner, 1000, {
    leading: true,
    trailing: false,
  });
  return throttledFetchRouteInner();
}

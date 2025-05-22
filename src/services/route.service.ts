// src/services/route.service.ts
import axios, { type AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import throttle from 'lodash/throttle';

type Coord = [number, number];
// ORS expects bearing as [value, range] or [[arrival_value, range], [departure_value, range]]
// null means no bearing constraint for that point.
export type BearingValue = [number, number] | [[number, number], [number, number]] | null;

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

export async function getRoute(
  coordinates: Coord[],
  radiuses?: number[],
  bearings?: BearingValue[] // Added bearings parameter
) {
  const plainCoordinates = JSON.parse(JSON.stringify(coordinates)) as Coord[];

  const cachePayload: {
    coordinates: Coord[];
    radiuses?: number[];
    bearings?: BearingValue[]; // Added to cache key
  } = { coordinates: plainCoordinates };

  if (radiuses && radiuses.length === plainCoordinates.length) {
    cachePayload.radiuses = radiuses;
  }
  if (bearings && bearings.length === plainCoordinates.length) {
    cachePayload.bearings = bearings; // Add to cache payload
  }

  const key = JSON.stringify(cachePayload); // Cache key now includes bearings

  if (routeCache.has(key)) {
    console.log('[RouteService] Returning cached route for key:', key);
    return Promise.resolve(routeCache.get(key));
  }

  const fetchRoute = async () => {
    console.log('[RouteService] Fetching new route. Coordinates:', plainCoordinates, 'Radiuses:', radiuses, 'Bearings:', bearings);

    const requestBody: {
      coordinates: Coord[];
      radiuses?: number[];
      bearings?: BearingValue[]; // Added to request body
      extra_info?: string[];
      instructions?: boolean;
      preference?: string;
    } = {
      coordinates: plainCoordinates,
      // extra_info: ['surface', 'waytype', 'steepness'], // Consider making this configurable
    };

    if (radiuses && radiuses.length === plainCoordinates.length) {
      requestBody.radiuses = radiuses;
    }
    if (bearings && bearings.length === plainCoordinates.length) {
      requestBody.bearings = bearings; // Add bearings to the ORS request
    }

    try {
      const response = await ors.post('/v2/directions/cycling-regular/geojson', requestBody);
      console.log('[RouteService] ORS response status:', response.status);
      routeCache.set(key, response.data);
      return response.data;
    } catch (error: any) {
      console.error('[RouteService] Error fetching route from ORS:', error.isAxiosError ? error.toJSON() : error);
      if (error.response) {
        console.error('[RouteService] ORS Error Response Data:', error.response.data);
        if (error.response.data && error.response.data.error) {
          // Construct a more informative error message from ORS if possible
          let orsErrorMessage = error.response.data.error.message;
          if (error.response.data.error.details) {
            orsErrorMessage += ` Details: ${JSON.stringify(error.response.data.error.details)}`;
          }
          throw new Error(`ORS API Error: ${orsErrorMessage}`);
        }
      }
      throw error;
    }
  };

  const throttledFetch = throttle(fetchRoute, 1000, {
    leading: true,
    trailing: false,
  });

  return throttledFetch();
}

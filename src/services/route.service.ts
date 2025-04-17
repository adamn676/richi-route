// src/services/route.service.ts
import axios, { type AxiosInstance } from "axios";
import axiosRetry from "axios-retry";
import throttle from "lodash/throttle";

const ors: AxiosInstance = axios.create({
  baseURL: "https://api.openrouteservice.org",
  headers: { Authorization: import.meta.env.VITE_ORS_API_KEY },
  timeout: 10000,
});

axiosRetry(ors, {
  retries: 3,
  retryCondition: (error) => error.response?.status === 429,
  retryDelay: axiosRetry.exponentialDelay,
});

const routeCache = new Map<string, any>();

export async function getRoute(coordinates: [number, number][]) {
  const key = JSON.stringify(coordinates);
  if (routeCache.has(key)) {
    return routeCache.get(key);
  }
  const fetchRoute = async () => {
    const response = await ors.post("/v2/directions/cycling-regular/geojson", {
      coordinates,
    });
    return response.data;
  };
  const throttledFetch = throttle(fetchRoute, 1000, {
    leading: true,
    trailing: false,
  });
  const data = await throttledFetch();
  routeCache.set(key, data);
  return data;
}

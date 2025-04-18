// src/services/geolocation.service.ts

import axios from "axios";
import type { BBox } from "geojson";

/**
 * Options for the geolocation lookup.
 */
export type GeolocationInfoOptions = {
  /**
   * Override the MapTiler Cloud API key (otherwise uses VITE_MAPTILER_API_KEY)
   */
  apiKey?: string;
};

/**
 * Result returned by MapTiler’s IP Geolocation API.
 */
export interface GeolocationResult {
  country?: string;
  country_code?: string;
  country_bounds?: BBox;
  country_languages?: string[];
  continent?: string;
  continent_code?: string;
  eu?: boolean;
  city?: string;
  latitude?: number;
  longitude?: number;
  postal?: string;
  region?: string;
  region_code?: string;
  timezone?: string;
}

/**
 * Looks up geolocation details from the client IP address
 * using MapTiler’s Geolocation API.
 *
 * Docs: https://docs.maptiler.com/cloud/api/geolocation/#ip-geolocation
 */
export async function info(
  options: GeolocationInfoOptions = {}
): Promise<GeolocationResult> {
  const key = options.apiKey ?? import.meta.env.VITE_MAPTILER_API_KEY;
  const url = "https://api.maptiler.com/geolocation/ip.json";
  const res = await axios.get(url, { params: { key } });
  if (res.status !== 200) {
    throw new Error(`Geolocation lookup failed (${res.status})`);
  }
  return res.data as GeolocationResult;
}

export const geolocation = { info };

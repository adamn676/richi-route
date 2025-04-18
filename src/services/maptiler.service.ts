// src/services/maptiler.service.ts
import axios from "axios";

export type Coord = [number, number];

export type PlaceType =
  | "continental_marine"
  | "country"
  | "major_landform"
  | "region"
  | "subregion"
  | "county"
  | "joint_municipality"
  | "joint_submunicipality"
  | "municipality"
  | "municipal_district"
  | "locality"
  | "neighbourhood"
  | "place"
  | "postal_code"
  | "address"
  | "road"
  | "poi";

export interface Place {
  label: string;
  coord: Coord;
  kind: string;
  raw: any;
}

const GEOCODE_BASE = "https://api.maptiler.com/geocoding";
const API_KEY = import.meta.env.VITE_MAPTILER_API_KEY;

/**
 * Reverse‑geocode a coordinate into a Place, optionally filtering types.
 */
export async function reverseGeocode(
  coord: Coord,
  types: PlaceType[] = []
): Promise<Place | null> {
  try {
    const [lng, lat] = coord;
    const url = `${GEOCODE_BASE}/${lng},${lat}.json`;
    const params: Record<string, string> = { key: API_KEY };
    if (types.length) {
      params.types = types.join(",");
    }
    const res = await axios.get(url, { params });
    const feat = res.data.features?.[0];
    if (!feat || !feat.place_name) return null;
    return {
      label: feat.place_name as string,
      coord: [feat.center[0], feat.center[1]] as Coord,
      kind:
        (feat.place_type && feat.place_type[0]) || feat.properties?.kind || "",
      raw: feat,
    };
  } catch (err) {
    console.error("reverseGeocode error:", err);
    return null;
  }
}

/**
 * Forward‑geocode a query into Places, optionally filtering types.
 */
export async function forwardGeocode(
  query: string,
  types: PlaceType[] = ["address", "road", "poi", "place", "region"]
): Promise<Place[]> {
  try {
    const url = `${GEOCODE_BASE}/${encodeURIComponent(query)}.json`;
    const params: Record<string, string> = { key: API_KEY };
    if (types.length) {
      params.types = types.join(",");
    }
    const res = await axios.get(url, { params });
    return (res.data.features || []).map((feat: any) => ({
      label: feat.place_name as string,
      coord: [feat.center[0], feat.center[1]] as Coord,
      kind:
        (feat.place_type && feat.place_type[0]) || feat.properties?.kind || "",
      raw: feat,
    }));
  } catch (err) {
    console.error("forwardGeocode error:", err);
    return [];
  }
}

/**
 * Build a MapTiler style URL for MapLibre.
 */
export function getMapTilerStyleUrl(styleType: string): string {
  const key = API_KEY;
  switch (styleType) {
    case "outdoor":
      return `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${key}`;
    case "streets":
    default:
      return `https://api.maptiler.com/maps/streets-v2/style.json?key=${key}`;
  }
}

// src/types/index.ts
/**
 * Central place for shared TypeScript types across the app.
 * — coordinate tuples
 * — our GeoJSON route shape
 * — any other domain types you add later (e.g. user profiles, settings, etc.)
 */

// src/types/index.ts
import type { FeatureCollection as GeoJSONFeatureCollection, LineString as GeoJSONLineString, GeoJsonProperties, Geometry } from 'geojson';

// Coordinates
export type Coord = [number, number];

// Bearing related types
export type SimpleBearing = [number, number]; // [angleDegrees, toleranceDegrees]
export type BearingValue = SimpleBearing | [[number, number], [number, number]] | null; // Allows for complex start/end if ever needed by ORS for those

// ORS Specific Types
export interface OrsQuery {
  coordinates: Coord[];
  profile: string;
  format: string;
  radiuses?: number[];
  bearings?: (SimpleBearing | null)[];
  // Add other query parameters ORS might return in metadata
}

export interface OrsEngine {
  version: string;
  build_date: string;
  graph_date: string;
}

export interface OrsMetadata {
  attribution: string;
  service: string;
  timestamp: number;
  query: OrsQuery;
  engine: OrsEngine;
}

// Main ORS FeatureCollection type used by services and stores
export interface OrsFeatureCollection extends GeoJSONFeatureCollection<GeoJSONLineString, GeoJsonProperties> {
  metadata?: OrsMetadata;
  // bbox is standard in GeoJSONFeatureCollection
}

// Your existing Waypoint and ShapePoint interfaces might also live here or be imported by the store
// If they are defined in route.store.ts, that's fine too, but for wider use, types.ts is good.
// For example:
// export interface Waypoint { /* ... */ }
// export interface ShapePoint { /* ... */ }

// Any other shared application types

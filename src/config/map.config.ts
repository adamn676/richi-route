// src/config/map.config.ts

// ——————————————————————————————————————————————————
// Map centering & zoom defaults
// ——————————————————————————————————————————————————

/**
 * Default center coordinates for Graz (used when no other location is known).
 */
export const DEFAULT_CENTER: [number, number] = [15.4333, 47.0667];

/**
 * Zoom level when centering on a known user location.
 */
export const DEFAULT_ZOOM = 12;

/**
 * Zoom level when only a rough location is available (e.g. IP fallback).
 */
export const ROUGH_ZOOM = 5;

// ——————————————————————————————————————————————————
// Route‑interaction threshold distances (meters)
// ——————————————————————————————————————————————————

/**
 * How close (in meters) a click must be to the route to count as “on the route”
 * for segment highlighting or inserting a hard point.
 */
export const DIST_ROUTE = 5;

/**
 * How close (in meters) a click must be to an existing waypoint
 * to count as “on the waypoint” for removal or dragging.
 */
export const DIST_EXISTING = 10;

// ——————————————————————————————————————————————————
// Map layer & source identifiers
// ——————————————————————————————————————————————————

/** GeoJSON source ID for your route line */
export const ROUTE_SOURCE_ID = "routeSource";

/** Layer ID for rendering your route line */
export const ROUTE_LAYER_ID = "routeLayer";

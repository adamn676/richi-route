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
// ORS API Request Parameters
// ——————————————————————————————————————————————————

/**
 * Default radius in meters for hard waypoints sent to OpenRouteService.
 * This allows ORS to snap to the nearest routable road within this radius.
 */
export const DEFAULT_WAYPOINT_ORS_RADIUS = 25;

/**
 * Default radius in meters for shaping points sent to OpenRouteService.
 * Often, this might be smaller or dynamically calculated based on zoom.
 * Your `getRadiusForZoom` function in `mapHelpers.ts` currently returns 7.
 */
export const DEFAULT_SHAPING_POINT_ORS_RADIUS = 7;

// ——————————————————————————————————————————————————
// Map layer & source identifiers
// ——————————————————————————————————————————————————

/**
 * Source ID for the full-route GeoJSON.
 * This source holds a single LineString feature representing
 * the entire calculated route (start → via → end).
 */
export const ROUTE_SOURCE_ID = 'routeSource';

/**
 * Layer ID for rendering the full-route line.
 * Renders the LineString from ROUTE_SOURCE_ID as one continuous polyline.
 */
export const ROUTE_LAYER_ID = 'routeLayer';

/**
 * Source ID for per‑segment GeoJSON.
 * This source holds multiple LineString features, each one representing
 * a pair of consecutive coordinates from the full route (i.e. each “segment”).
 */
export const SEGMENTS_SOURCE_ID = 'segments-source';

/**
 * Layer ID for drawing each segment in its base style.
 * Uses SEGMENTS_SOURCE_ID and renders every segment (thin blue line).
 */
export const SEGMENTS_BASE_LAYER = 'segments-base';

/**
 * Layer ID for highlighting a single segment on hover.
 * Also uses SEGMENTS_SOURCE_ID but applies a filter to show exactly
 * the hovered segment in a thicker, lighter color.
 */
export const SEGMENTS_HIGHLIGHT_LAYER = 'segments-highlight';

/**
 * Layer ID for the route outline/border.
 * Used to create a thicker line beneath the main route line for a border effect.
 */
export const SEGMENTS_OUTLINE_LAYER = 'segments-outline';

/**
 * Layer ID for optional pattern effects on the route line.
 * Can be used for dashed lines, dots, or other decorative patterns on the route.
 * Currently unused in the default implementation.
 */
export const SEGMENTS_PATTERN_LAYER = 'segments-pattern';

export const SEGMENTS_ARROWS_LAYER = 'segments-arrows';

// src/utils/mapHelpers.ts

/**
 * Calculates a suitable radius in meters for shaping points based on the map's zoom level.
 * Higher zoom levels (more detail) result in smaller radii for more precise shaping.
 * @param zoom The current map zoom level.
 * @returns The calculated radius in meters.
 */
export function getRadiusForZoom(zoom: number): number {
  if (zoom > 17) {
    return 5; // Very zoomed in, small radius for precision
  }
  if (zoom > 14) {
    return 10; // Mid-level zoom
  }
  if (zoom > 11) {
    return 20; // Broader area
  }
  return 35; // Low zoom, larger radius
}

// Add other map-related helper functions here in the future if needed.

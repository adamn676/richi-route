// src/utils/mapHelpers.ts

/**
 * Calculates a suitable radius in meters for shaping points based on the map's zoom level.
 * Higher zoom levels (more detail) result in smaller radii for more precise shaping.
 * @param zoom The current map zoom level.
 * @returns The calculated radius in meters.
 */
export function getRadiusForZoom(zoom: number): number {
  // if (zoom > 17) {
  //   // Zoomed in very close
  //   return 5; // Try 5m (was 15m in our last working test, 10m in OptionA)
  // }
  // if (zoom > 14) {
  //   // Common planning zoom (e.g., 15-17, where you are dragging)
  //   return 7; // Try 7m (was 20m in our last working test, 15m in OptionA)
  // }
  // if (zoom > 11) {
  //   // Broader area
  //   return 15; // Was 30m, then 25m
  // }
  // return 30; // Low zoom, was 50m
  return 7;
}

// Add other map-related helper functions here in the future if needed.

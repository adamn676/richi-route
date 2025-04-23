import type { Feature, FeatureCollection, LineString } from "geojson";

/**
 * Splits the route line into individual segments,
 * each with an `idx` property for highlighting.
 */
export function getSegments(
  fc: FeatureCollection
): Feature<LineString, { idx: number }>[] {
  // 1) Extract coordinates from the first feature's geometry
  const coords = (fc.features[0].geometry as LineString).coordinates;

  // 2) For each pair of consecutive points, create a single-segment line
  return coords.slice(0, -1).map((start, i) => ({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [start, coords[i + 1]], // use coords here
    },
    properties: { idx: i },
  }));
}

/**
 * Returns a new FeatureCollection with a single LineString (the full route)
 * so we can place arrows along its entire path.
 */
export function getRouteLineForArrows(
  fc: FeatureCollection
): FeatureCollection {
  const coords = (fc.features[0].geometry as LineString).coordinates;

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: coords, // use coords
        },
        properties: {},
      },
    ],
  };
}

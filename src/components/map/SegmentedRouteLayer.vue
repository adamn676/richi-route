<!-- src/components/map/SegmentedRouteLayer.vue -->
<template>
  <div />
</template>

<script setup lang="ts">
import { watch } from "vue";
import type { FeatureCollection, Feature, LineString } from "geojson";
import {
  SEGMENTS_SOURCE_ID,
  SEGMENTS_BASE_LAYER,
  SEGMENTS_HIGHLIGHT_LAYER,
} from "@/config/map.config";

const props = defineProps<{
  map: any;
  route: FeatureCollection | null;
}>();

/**
 * Breaks a multi‑coordinate LineString into single‑segment Features,
 * tagging each with its segment index.  This allows hover/highlight
 * logic on a per‑segment basis.
 */
function getSegments(
  fc: FeatureCollection
): Feature<LineString, { idx: number }>[] {
  // Grab the backbone coordinates from your one-and-only Feature
  const coords = (fc.features[0].geometry as LineString).coordinates;

  // For each consecutive pair, emit a 2‑point LineString with idx
  return coords.slice(0, -1).map((start, i) => ({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [start, coords[i + 1]],
    },
    properties: { idx: i },
  }));
}

/**
 * (Re)draws the segment layers:
 * 1. Removes any old layers/source.
 * 2. Adds a GeoJSON source of individual segments.
 * 3. Adds a base line layer + a highlight layer filtered by idx.
 * 4. Hooks up mouse events for hover highlighting.
 */
function draw(m: any, route: FeatureCollection) {
  // 1. tear down any previous segment layers/source
  if (m.getLayer(SEGMENTS_HIGHLIGHT_LAYER))
    m.removeLayer(SEGMENTS_HIGHLIGHT_LAYER);
  if (m.getLayer(SEGMENTS_BASE_LAYER)) m.removeLayer(SEGMENTS_BASE_LAYER);
  if (m.getSource(SEGMENTS_SOURCE_ID)) m.removeSource(SEGMENTS_SOURCE_ID);

  // 2. build a FeatureCollection of 1‑segment features
  const segments = getSegments(route);
  const geojson = { type: "FeatureCollection", features: segments };

  // 3. add source + base + highlight layers
  m.addSource(SEGMENTS_SOURCE_ID, { type: "geojson", data: geojson } as any);
  m.addLayer({
    id: SEGMENTS_BASE_LAYER,
    type: "line",
    source: SEGMENTS_SOURCE_ID,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#3b82f6", "line-width": 4 },
  });
  m.addLayer({
    id: SEGMENTS_HIGHLIGHT_LAYER,
    type: "line",
    source: SEGMENTS_SOURCE_ID,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#60a5fa", "line-width": 6 },
    filter: ["==", "idx", -1], // start with none highlighted
  });

  // 4. on hover, update the highlight filter to the hovered idx
  m.on("mousemove", SEGMENTS_BASE_LAYER, (e: any) => {
    const f = e.features?.[0] as
      | Feature<LineString, { idx: number }>
      | undefined;
    const idx = f?.properties.idx ?? -1;
    m.setFilter(SEGMENTS_HIGHLIGHT_LAYER, ["==", "idx", idx]);
  });
  m.on("mouseleave", SEGMENTS_BASE_LAYER, () => {
    m.setFilter(SEGMENTS_HIGHLIGHT_LAYER, ["==", "idx", -1]);
  });
}

// Watch for changes to the route prop; whenever it updates,
// redraw the segments—waiting for style load on the first run.
watch(
  () => props.route,
  (route) => {
    const m = props.map;
    if (!m || !route) return;
    // If style isn’t ready yet, defer until load event
    if (!m.isStyleLoaded?.()) {
      m.once("load", () => draw(m, route));
    } else {
      draw(m, route);
    }
  },
  { immediate: true }
);
</script>

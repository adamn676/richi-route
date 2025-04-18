<!-- src/components/map/SegmentedRouteLayer.vue -->
<template>
  <div />
</template>

<script setup lang="ts">
import { watch } from "vue";
import type { FeatureCollection, Feature, LineString } from "geojson";

const props = defineProps<{
  map: any;
  route: FeatureCollection | null;
}>();

const SOURCE_ID = "segments-source";
const BASE_LAYER = "segments-base";
const HIGHLIGHT_LYR = "segments-highlight";

// Split a LineString into single‐segment features
function getSegments(
  fc: FeatureCollection
): Feature<LineString, { idx: number }>[] {
  const coords = (fc.features[0].geometry as LineString).coordinates;
  return coords.slice(0, -1).map((c, i) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: [c, coords[i + 1]] },
    properties: { idx: i },
  }));
}

function draw(m: any, route: FeatureCollection) {
  // teardown
  if (m.getLayer(HIGHLIGHT_LYR)) m.removeLayer(HIGHLIGHT_LYR);
  if (m.getLayer(BASE_LAYER)) m.removeLayer(BASE_LAYER);
  if (m.getSource(SOURCE_ID)) m.removeSource(SOURCE_ID);

  const segments = getSegments(route);
  const geojson = { type: "FeatureCollection", features: segments };

  m.addSource(SOURCE_ID, { type: "geojson", data: geojson } as any);
  m.addLayer({
    id: BASE_LAYER,
    type: "line",
    source: SOURCE_ID,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#3b82f6", "line-width": 4 },
  });
  m.addLayer({
    id: HIGHLIGHT_LYR,
    type: "line",
    source: SOURCE_ID,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#60a5fa", "line-width": 6 },
    filter: ["==", "idx", -1], // start with none highlighted
  });

  // hover highlight
  m.on("mousemove", BASE_LAYER, (e: any) => {
    const f = e.features?.[0] as
      | Feature<LineString, { idx: number }>
      | undefined;
    m.setFilter(HIGHLIGHT_LYR, ["==", "idx", f?.properties.idx ?? -1]);
  });
  m.on("mouseleave", BASE_LAYER, () => {
    m.setFilter(HIGHLIGHT_LYR, ["==", "idx", -1]);
  });
}

watch(
  () => props.route,
  (route) => {
    const m = props.map;
    if (!m || !route) return;
    // wait until the map’s style has loaded (only needed first time)
    if (!m.isStyleLoaded?.()) {
      m.once("load", () => draw(m, route));
    } else {
      draw(m, route);
    }
  },
  { immediate: true }
);
</script>

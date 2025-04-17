<!-- src/components/map/SegmentedRouteLayer.vue -->
<template>
  <!-- Invisible wrapper; layers managed directly on the map -->
  <div />
</template>

<script setup lang="ts">
import { watch } from "vue";
import type { FeatureCollection, Feature, LineString } from "geojson";
import { useMap } from "@/composables/useMap";

const props = defineProps<{ route: FeatureCollection | null }>();
const { map } = useMap("map");

const sourceId = "segments-source";
const baseLayerId = "segments-base";
const highlightLayerId = "segments-highlight";

// Return an array of GeoJSON Features representing each segment
function getSegments(
  fc: FeatureCollection
): Feature<LineString, { idx: number }>[] {
  const coords = (fc.features[0].geometry as LineString).coordinates;
  return coords.slice(0, -1).map((c, i) => {
    const segment: Feature<LineString, { idx: number }> = {
      type: "Feature",
      geometry: { type: "LineString", coordinates: [c, coords[i + 1]] },
      properties: { idx: i },
    };
    return segment;
  });
}

watch(
  () => props.route,
  (route) => {
    const m = map.value;
    if (!m) return;

    // Cleanup existing layers and source
    if (m.getLayer(highlightLayerId)) {
      m.removeLayer(highlightLayerId);
    }
    if (m.getLayer(baseLayerId)) {
      m.removeLayer(baseLayerId);
    }
    if (m.getSource(sourceId)) {
      m.removeSource(sourceId);
    }

    if (route) {
      // Build typed GeoJSON FeatureCollection
      const segments = getSegments(route);
      const geojson: FeatureCollection<LineString, { idx: number }> = {
        type: "FeatureCollection",
        features: segments,
      };

      // Add source and layers
      m.addSource(sourceId, { type: "geojson", data: geojson });

      m.addLayer({
        id: baseLayerId,
        type: "line",
        source: sourceId,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#3b82f6", "line-width": 4 },
      });

      m.addLayer({
        id: highlightLayerId,
        type: "line",
        source: sourceId,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#60a5fa", "line-width": 6 },
        filter: ["==", "idx", -1],
      });

      // Hover interactions
      m.on("mousemove", baseLayerId, (e) => {
        const feature = e.features?.[0] as
          | Feature<LineString, { idx: number }>
          | undefined;
        const idx = feature?.properties.idx ?? -1;
        m.setFilter(highlightLayerId, ["==", "idx", idx]);
      });

      m.on("mouseleave", baseLayerId, () => {
        m.setFilter(highlightLayerId, ["==", "idx", -1]);
      });
    }
  },
  { immediate: true }
);
</script>

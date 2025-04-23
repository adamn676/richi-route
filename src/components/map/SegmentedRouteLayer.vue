<!-- src/components/map/SegmentedRouteLayer.vue -->

<template>
  <!-- This component doesn't display any HTML.
       It exists to watch `route` and call the composable's drawing logic. -->
  <div />
</template>

<script setup lang="ts">
import { watch } from "vue";
import maplibregl from "maplibre-gl";
import type { FeatureCollection } from "geojson";

// Our composable that draws the route segments
import { useSegmentedRoute } from "@/composables/useSegmentedRoute";

const props = defineProps<{
  map: maplibregl.Map;
  route: FeatureCollection | null;
}>();

const { renderSegments } = useSegmentedRoute();

/**
 * Watch for changes to `route` prop:
 *  - If `map` and `route` are present and style is loaded, call `renderSegments`.
 */
watch(
  () => props.route,
  (newRoute) => {
    if (!props.map || !newRoute) return;

    // If map style isn't loaded yet, wait for "load" event
    if (!props.map.isStyleLoaded()) {
      props.map.once("load", () => {
        renderSegments(props.map, newRoute);
      });
    } else {
      renderSegments(props.map, newRoute);
    }
  },
  { immediate: true }
);
</script>

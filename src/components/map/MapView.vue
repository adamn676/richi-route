<!-- src/components/map/MapView.vue -->
<template>
  <div id="map" class="h-full w-full">
    <!-- Only render segment layers once the map is initialized -->
    <SegmentedRouteLayer v-if="map" :map="map" :route="routeStore.route" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import maplibregl, { Marker } from "maplibre-gl";

import { useMap } from "@/composables/useMap";
import { useRouteStore } from "@/stores/route.store";
import { useNotification } from "@/composables/useNotification";
import { useRouteCalculation } from "@/composables/useRouteCalculation";
import { useRouteDragging } from "@/composables/useRouteDragging";
import SegmentedRouteLayer from "@/components/map/SegmentedRouteLayer.vue";
import { SEGMENTS_BASE_LAYER } from "@/config/map.config";

// 1️⃣ Initialize MapLibre in the '#map' container.
//    `map` is a Ref<MaplibreMap | null>.
const { map } = useMap("map");

// 2️⃣ Pinia store + toast helper
const routeStore = useRouteStore();
const notify = useNotification();

// 3️⃣ Wire up automatic recalculation & drag‑to‑shape logic
useRouteCalculation({ map });
useRouteDragging({ map });

// 4️⃣ Debounce flag so we don’t spam ORS with back‑to‑back clicks
const isCalc = ref(false);

// 5️⃣ Keep track of Marker instances so we can clean them up
let hardMarkers: Marker[] = [];
let softMarkers: Marker[] = [];

/**
 * Sets up the click handler on the map:
 * - Click on a segment → insert a new hard stop there
 * - Otherwise → add a new hard stop at the click point
 */
function setupClickHandler(m: maplibregl.Map) {
  m.on("click", async (e) => {
    // 1. if clicked on an existing segment, insert there
    if (routeStore.route && m.getLayer(SEGMENTS_BASE_LAYER)) {
      const feats = m.queryRenderedFeatures(e.point, {
        layers: [SEGMENTS_BASE_LAYER],
      });
      if (feats.length) {
        const idx = (feats[0].properties as any).idx as number;
        await routeStore.insertWaypoint(idx + 1, [e.lngLat.lng, e.lngLat.lat]);
        return;
      }
    }

    // 2. fallback: new hard stop
    if (isCalc.value) {
      notify.info("Please wait for calculation.");
      return;
    }
    isCalc.value = true;
    try {
      await routeStore.addWaypoint([e.lngLat.lng, e.lngLat.lat]);
    } finally {
      // re-enable clicks after a short delay
      setTimeout(() => (isCalc.value = false), 500);
    }
  });
}

// Attach the click handler once the map instance is ready
onMounted(() => {
  watch(
    () => map.value,
    (m) => {
      if (m) setupClickHandler(m as any);
    },
    { immediate: true }
  );
});

/**
 * Watch hard‐stop waypoints and render blue markers.
 */
watch(
  () => routeStore.waypoints.slice(),
  (wps) => {
    const m = map.value;
    if (!m) return;
    // remove old markers
    hardMarkers.forEach((mk) => mk.remove());
    hardMarkers = [];
    // add new markers
    for (const coord of wps) {
      const mk = new maplibregl.Marker({ color: "#3b82f6" })
        .setLngLat(coord)
        //@ts-ignore
        .addTo(m);
      hardMarkers.push(mk);
    }
  },
  { immediate: true }
);

/**
 * Watch soft‐shaping points and render orange markers.
 */
watch(
  () => routeStore.shapingPoints.slice(),
  (sps) => {
    const m = map.value;
    if (!m) return;
    softMarkers.forEach((mk) => mk.remove());
    softMarkers = [];
    for (const { coord } of sps) {
      const mk = new maplibregl.Marker({ color: "#f59e0b" })
        .setLngLat(coord)
        //@ts-ignore
        .addTo(m);
      softMarkers.push(mk);
    }
  },
  { immediate: true }
);

/** Cleanup all markers on unmount */
onBeforeUnmount(() => {
  hardMarkers.forEach((mk) => mk.remove());
  softMarkers.forEach((mk) => mk.remove());
});
</script>

<style scoped>
#map {
  /* ensure the map container fills its parent */
  position: relative;
  height: 100%;
  width: 100%;
}
</style>

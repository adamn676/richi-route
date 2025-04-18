<!-- src/components/map/MapView.vue -->
<template>
  <div id="map" class="h-full w-full">
    <!-- only render once the real map exists -->
    <SegmentedRouteLayer v-if="map" :map="map" :route="routeStore.route" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import maplibregl, { Marker as MaplibreMarker } from "maplibre-gl";

import { useMap } from "@/composables/useMap";
import { useRouteStore } from "@/stores/route.store";
import { useNotification } from "@/composables/useNotification";
import { useRouteCalculation } from "@/composables/useRouteCalculation";
import { useRouteDragging } from "@/composables/useRouteDragging";
import SegmentedRouteLayer from "@/components/map/SegmentedRouteLayer.vue";

// 1️⃣ initialize MapLibre
const { map } = useMap("map"); // map is Ref<MaplibreMap|null>

// 2️⃣ store + toasts
const routeStore = useRouteStore();
const notify = useNotification();

// 3️⃣ wiring up composables
useRouteCalculation({ map });
useRouteDragging({ map });

// 4️⃣ debounce flag
const isCalc = ref(false);

// 5️⃣ plain arrays for markers
let hardMarkers: MaplibreMarker[] = [];
let softMarkers: MaplibreMarker[] = [];

/** 6️⃣ click to add/insert **/
onMounted(() => {
  watch(
    () => map.value,
    (mv) => {
      if (!mv) return;
      mv.on("click", async (e) => {
        // if clicked on an existing segment, insert there
        if (routeStore.route && mv.getLayer("segments-base")) {
          const feats = mv.queryRenderedFeatures(e.point, {
            layers: ["segments-base"],
          });
          if (feats.length) {
            const idx = (feats[0].properties as any).idx as number;
            await routeStore.insertWaypoint(idx + 1, [
              e.lngLat.lng,
              e.lngLat.lat,
            ]);
            return;
          }
        }

        // otherwise create a new waypoint
        if (isCalc.value) {
          notify.info("Please wait for calculation.");
          return;
        }
        isCalc.value = true;
        try {
          await routeStore.addWaypoint([e.lngLat.lng, e.lngLat.lat]);
        } finally {
          setTimeout(() => (isCalc.value = false), 500);
        }
      });
    },
    { immediate: true }
  );
});

/** 7️⃣ blue “hard” markers watcher **/
watch(
  () => routeStore.waypoints.slice(),
  (wps) => {
    const mv = map.value;
    if (!mv) return;
    // remove old
    hardMarkers.forEach((mk) => mk.remove());
    hardMarkers = [];
    // add new
    for (const coord of wps) {
      const mk = new maplibregl.Marker({ color: "#3b82f6" })
        .setLngLat(coord)
        // @ts-ignore
        .addTo(mv);
      hardMarkers.push(mk as MaplibreMarker);
    }
  },
  { immediate: true }
);

/** 8️⃣ orange “soft” markers watcher **/
watch(
  () => routeStore.shapingPoints.slice(),
  (sps) => {
    const mv = map.value;
    if (!mv) return;
    softMarkers.forEach((mk) => mk.remove());
    softMarkers = [];
    for (const { coord } of sps) {
      const mk = new maplibregl.Marker({ color: "#f59e0b" })
        .setLngLat(coord)
        // @ts-ignore
        .addTo(mv);
      softMarkers.push(mk as MaplibreMarker);
    }
  },
  { immediate: true }
);

/** 9️⃣ cleanup **/
onBeforeUnmount(() => {
  hardMarkers.forEach((mk) => mk.remove());
  softMarkers.forEach((mk) => mk.remove());
});
</script>

<style scoped>
#map {
  position: relative;
}
</style>

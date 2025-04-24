<template>
  <div id="map" class="h-full w-full">
    <SegmentedRouteLayer v-if="map" :map="map" :route="routeStore.route" />
  </div>
</template>

<script setup lang="ts">
import { useMap } from "@/composables/useMap";
import { useRouteStore } from "@/stores/route.store";
import SegmentedRouteLayer from "@/components/map/SegmentedRouteLayer.vue";

// Our new composables
import { useMapInteractions } from "@/composables/useMapInteractions";
import { useMarkerWatches } from "@/composables/useMarkerWatches";

// Existing
import { useRouteCalculation } from "@/composables/useRouteCalculation";
import { useRouteDragging } from "@/composables/useRouteDragging";

// 1) Initialize map
const { map } = useMap("map"); // map is Ref<maplibregl.Map|null>

// 2) route store
const routeStore = useRouteStore();

// 3) Use other composables
useRouteCalculation({ map });
useRouteDragging({ map });

useMapInteractions(map, routeStore);
useMarkerWatches(map, routeStore);
</script>

<style scoped>
#map {
  position: relative;
  height: 100%;
  width: 100%;
}
</style>

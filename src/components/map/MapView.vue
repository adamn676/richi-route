<template>
  <div id="map" class="h-full w-full">
    <SegmentedRouteLayer v-if="map" :map="map" :route="route" />
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { useRouteStore } from "@/stores/route.store";
import { useMap } from "@/composables/useMap";
import { useMapInteractions } from "@/composables/useMapInteractions";
import { useMarkerWatches } from "@/composables/useMarkerWatches";
import { useRouteCalculation } from "@/composables/useRouteCalculation";
import { useRouteDragging } from "@/composables/useRouteDragging";

import SegmentedRouteLayer from "@/components/map/SegmentedRouteLayer.vue";

const { map } = useMap("map");
const routeStore = useRouteStore();
const { route } = storeToRefs(routeStore);

// Use other composables
useRouteCalculation({ map });
useRouteDragging({ map });
useMapInteractions(map, routeStore);
useMarkerWatches(map, routeStore);
</script>

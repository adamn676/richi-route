<template>
  <div class="map-view">
    <div id="map" class="map-view__canvas" aria-label="Interaktive Karte von Graz" />
    <SegmentedRouteLayer v-if="map" :map="map" :route="initialRouting ? null : route" />
    <GpxReferenceLayer v-if="map" :map="map" :track="gpxTrack" :visible="gpxVisible" :fit-request="gpxFitRequest" />
    <SurfaceFocusLayer v-if="map" :map="map" :focus="focusedSurface" />
    <div class="map-view__controls">
      <label>Karte <select v-model="basemap" aria-label="Kartenansicht">
        <option value="street">Straßenkarte</option>
        <option value="aerial">Luftbild + Straßennamen</option>
        <option value="local">Lokale Straßen</option>
      </select></label>
      <button type="button" :disabled="!route" @click="fitRoute">Route zeigen</button>
      <span v-if="initialRouting" class="map-view__progress" role="status">Route wird berechnet …</span>
    </div>
    <p v-if="mapError" class="map-view__error" role="alert">{{ mapError }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouteStore } from '@/stores/route.store';
import { LngLatBounds } from 'maplibre-gl';
import { useMap } from '@/composables/useEditorMap';
import { useMapInteractions } from '@/composables/useMapInteractions';
import { useMarkerWatches } from '@/composables/useMarkerWatches';
import { useRouteDragging } from '@/composables/useRouteDragging';
import SegmentedRouteLayer from '@/components/map/SegmentedRouteLayer.vue';
import SurfaceFocusLayer from '@/components/map/SurfaceFocusLayer.vue';
import GpxReferenceLayer from '@/components/map/GpxReferenceLayer.vue';
import { useGpxReferenceStore } from '@/stores/gpx-reference.store';

const { map, basemap, mapError } = useMap('map');
const { route, pendingSnapCount, pendingLegCount, focusedSurface } = storeToRefs(useRouteStore());
const { track: gpxTrack, visible: gpxVisible, fitRequest: gpxFitRequest } = storeToRefs(useGpxReferenceStore());
const presentedStartId = ref<string>();
const routingPending = computed(() => pendingSnapCount.value > 0 || pendingLegCount.value > 0);
const initialRouting = computed(() => Boolean(route.value?.features.length && routingPending.value &&
  presentedStartId.value !== route.value.features[0].properties.fromId));
watch([route, routingPending], ([value, pending]) => {
  if (!pending) presentedStartId.value = value?.features[0]?.properties.fromId;
}, { immediate: true });
useRouteDragging({ map });
useMapInteractions(map);
useMarkerWatches(map);
watch(map, instance => {
  if (instance) instance.once('load', () => {
    if (gpxTrack.value && gpxVisible.value) instance.fitBounds(gpxTrack.value.bounds, { padding: 50, maxZoom: 16, duration: 0 });
    else if (route.value) fitRoute();
  });
});
function fitRoute() {
  const bounds = new LngLatBounds();
  for (const feature of route.value?.features ?? []) {
    for (const coord of feature.geometry.coordinates) bounds.extend([coord[0], coord[1]]);
  }
  if (!bounds.isEmpty()) map.value?.fitBounds(bounds, { padding: 60, maxZoom: 16 });
}
</script>

<style scoped>
.map-view { position: relative; width: 100%; height: 100%; min-height: 0; }
.map-view__canvas { width: 100%; height: 100%; }
.map-view__controls { position: absolute; top: .75rem; left: .75rem; display: flex; flex-wrap: wrap; gap: .5rem; padding: .5rem; background: white; border-radius: .5rem; box-shadow: 0 2px 10px #0002; font-size: .8rem; }
.map-view__controls select, .map-view__controls button { padding: .45rem; border: 1px solid #cddbd9; border-radius: .3rem; background: white; }
.map-view__progress { align-self: center; color: #304951; }
.map-view__error {
  position: absolute;
  top: 4rem;
  left: 1rem;
  right: 1rem;
  z-index: 4;
  max-width: 30rem;
  padding: .75rem 1rem;
  border-radius: .65rem;
  background: #fff3ed;
  box-shadow: 0 4px 16px #0002;
  color: #81392d;
}
</style>

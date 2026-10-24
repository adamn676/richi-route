<template>
  <div class="map-view">
    <div id="map" class="map-view__canvas" aria-label="Interaktive Karte" />
    <SegmentedRouteLayer v-if="map" :map="map" :route="initialRouting ? null : route" />
    <GpxReferenceLayer v-if="map" :map="map" :track="gpxTrack" :visible="gpxVisible" :fit-request="gpxFitRequest" />
    <SurfaceFocusLayer v-if="map" :map="map" :focus="focusedSurface" />
    <RouteProfileLayer v-if="map" :map="map" :focus="routeProfileFocus" />
    <div class="map-view__controls">
      <label class="map-view__basemap" :title="onlineBasemap(basemap)?.description">
        <IconStack2 :size="18" aria-hidden="true" />
        <select v-model="basemap" class="btn" aria-label="Kartenansicht">
          <optgroup label="Eigene Karten · Europa">
            <option value="street">OpenStreetMap · lokal</option>
            <option value="cycling">Rennradkarte · Europa</option>
            <option value="terrain">Geländekarte · Europa</option>
            <option value="aerial-fast">Luftbild · schnell</option>
            <option value="aerial">Luftbild · Detail</option>
            <option value="local">Straßennetz</option>
          </optgroup>
          <optgroup label="Online · Internet erforderlich">
            <option v-for="item in onlineBasemaps" :key="item.id" :value="item.id">{{ item.label }}</option>
          </optgroup>
        </select>
      </label>
      <CyclingOverlays :map="map" />
      <button v-if="route" type="button" class="btn" @click="fitRoute"><IconFocus2 :size="18" aria-hidden="true" />Route zeigen</button>
      <span v-if="initialRouting" class="map-view__progress" role="status">Route wird berechnet …</span>
      <p v-if="mapError" class="notice notice--error map-view__error" role="alert">
        {{ mapError }} <button type="button" class="btn" @click="retryBasemap">Erneut laden</button>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouteStore } from '@/stores/route.store';
import { LngLatBounds } from 'maplibre-gl';
import { IconFocus2, IconStack2 } from '@/components/icons';
import { useMap } from '@/composables/useEditorMap';
import { useMapInteractions } from '@/composables/useMapInteractions';
import { useMarkerWatches } from '@/composables/useMarkerWatches';
import { useRouteDragging } from '@/composables/useRouteDragging';
import SegmentedRouteLayer from '@/components/map/SegmentedRouteLayer.vue';
import SurfaceFocusLayer from '@/components/map/SurfaceFocusLayer.vue';
import GpxReferenceLayer from '@/components/map/GpxReferenceLayer.vue';
import { useGpxReferenceStore } from '@/stores/gpx-reference.store';
import { useRouteProfileStore } from '@/stores/route-profile.store';
import RouteProfileLayer from '@/components/map/RouteProfileLayer.vue';
import CyclingOverlays from '@/components/map/CyclingOverlays.vue';
import { onlineBasemap, onlineBasemaps } from '@/config/online-basemaps';

const { map, basemap, mapError, retryBasemap } = useMap('map');
const { focus: routeProfileFocus } = storeToRefs(useRouteProfileStore());
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
.map-view { position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden; }
.map-view__canvas { width: 100%; height: 100%; }
.map-view__controls { position: absolute; top: .75rem; left: .75rem; right: .75rem; display: flex; flex-wrap: wrap; align-items: flex-start; gap: .5rem; pointer-events: none; }
.map-view__controls > * { border-radius: var(--radius); box-shadow: var(--shadow); pointer-events: auto; }
.map-view__basemap { position: relative; display: inline-flex; align-items: center; }
.map-view__basemap svg { position: absolute; left: .6rem; pointer-events: none; }
.map-view__basemap select { max-width: 15rem; padding-left: 2.1rem; }
.map-view__progress { padding: .45rem .75rem; background: var(--surface); font-size: .82rem; }
/* Below the controls, so it never covers them when they wrap. */
.map-view__error { flex-basis: 100%; max-width: 30rem; }
@media (max-width: 760px) { .map-view__controls { top: .5rem; left: .5rem; right: .5rem; } }
</style>

<template>
  <div class="map-view">
    <div class="map-view__stage" :class="{ 'map-view__stage--picking': streetView.picking }">
      <div id="map" class="map-view__canvas" aria-label="Interaktive Karte" />
      <SegmentedRouteLayer v-if="map" :map="map" :route="initialRouting ? null : route" />
      <GpxReferenceLayer v-if="map" :map="map" :track="gpxTrack" :visible="gpxVisible" :fit-request="gpxFitRequest" />
      <SurfaceFocusLayer v-if="map" :map="map" :focus="focusedSurface" />
      <RouteProfileLayer v-if="map" :map="map" :focus="routeProfileFocus" />
      <div class="map-view__status">
        <span v-if="initialRouting" class="map-view__progress" role="status">Route wird berechnet …</span>
        <span v-if="streetView.picking" class="map-view__progress" role="status">
          {{ streetView.missing ? 'Kein Street View hier' : 'Punkt auf der Karte anklicken' }} · Esc bricht ab</span>
        <p v-if="mapError" class="notice notice--error" role="alert">
          {{ mapError }} <button type="button" class="btn" @click="retryBasemap">Erneut laden</button>
        </p>
      </div>
      <div class="map-view__tools">
        <MapMenu label="Kartenansicht" heading="Kartenansicht" :title="basemapTitle">
          <template #icon><IconStack2 :size="20" aria-hidden="true" /></template>
          <template #default="{ close }">
            <fieldset v-for="group in basemapGroups" :key="group.label" class="map-view__basemaps">
              <legend class="label">{{ group.label }}</legend>
              <label v-for="item in group.items" :key="item.id" class="option" @click="event => pick(event, item.id, close)">
                <input v-model="basemap" type="radio" name="basemap" :value="item.id" />{{ item.label }}
              </label>
            </fieldset>
          </template>
        </MapMenu>
        <CyclingOverlays :map="map" />
        <button type="button" class="btn btn--icon btn--map map-view__street-view" :aria-pressed="streetView.picking" aria-label="Street View"
        title="Street View: Punkt auf der Karte wählen" @click="streetView.picking = !streetView.picking">
        <IconMan :size="20" aria-hidden="true" />
      </button>
      <button v-if="route" type="button" class="btn btn--icon btn--map" aria-label="Route zeigen" title="Route zeigen" @click="fitRoute">
          <IconFocus2 :size="20" aria-hidden="true" />
        </button>
      </div>
      <StreetViewPanel v-if="streetView.location" />
    </div>
    <ElevationProfile v-show="route" class="map-view__profile" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouteStore } from '@/stores/route.store';
import { LngLatBounds } from 'maplibre-gl';
import { IconFocus2, IconMan, IconStack2 } from '@/components/icons';
import { useMap } from '@/composables/useEditorMap';
import { useMapInteractions } from '@/composables/useMapInteractions';
import { useStreetViewMap } from '@/composables/useStreetViewMap';
import { useMarkerWatches } from '@/composables/useMarkerWatches';
import { useRouteDragging } from '@/composables/useRouteDragging';
import SegmentedRouteLayer from '@/components/map/SegmentedRouteLayer.vue';
import SurfaceFocusLayer from '@/components/map/SurfaceFocusLayer.vue';
import GpxReferenceLayer from '@/components/map/GpxReferenceLayer.vue';
import { useGpxReferenceStore } from '@/stores/gpx-reference.store';
import { useRouteProfileStore } from '@/stores/route-profile.store';
import RouteProfileLayer from '@/components/map/RouteProfileLayer.vue';
import CyclingOverlays from '@/components/map/CyclingOverlays.vue';
import ElevationProfile from '@/components/ui/ElevationProfile.vue';
import MapMenu from '@/components/map/MapMenu.vue';
import StreetViewPanel from '@/components/map/StreetViewPanel.vue';
import { useStreetViewStore } from '@/stores/street-view.store';
import { onlineBasemaps } from '@/config/online-basemaps';
import { localBasemaps, type EditorBasemap } from '@/config/basemaps';

const { map, basemap, mapError, retryBasemap } = useMap('map', 'map-credits');
const basemapGroups: { label: string; items: readonly { id: EditorBasemap; label: string }[] }[] = [
  { label: 'Eigene Karten · Europa', items: localBasemaps },
  { label: 'Online · Internet erforderlich', items: onlineBasemaps },
];
// A pointer choice applies the map and closes the menu; arrow keys (clicks with detail 0) only move the selection.
// A click on the label text skips the label's default action, which would pull focus into the closing panel.
function pick(event: MouseEvent, id: EditorBasemap, close: (refocus?: boolean) => void) {
  if (!event.detail) return;
  if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
  basemap.value = id;
  close(true);
}
const basemapTitle = computed(() =>
  `Kartenansicht: ${basemapGroups.flatMap(group => group.items).find(item => item.id === basemap.value)?.label}`);
const { focus: routeProfileFocus } = storeToRefs(useRouteProfileStore());
const { route, routingPending, focusedSurface } = storeToRefs(useRouteStore());
const { track: gpxTrack, visible: gpxVisible, fitRequest: gpxFitRequest } = storeToRefs(useGpxReferenceStore());
const presentedStartId = ref<string>();
const initialRouting = computed(() => Boolean(route.value?.features.length && routingPending.value &&
  presentedStartId.value !== route.value.features[0].properties.fromId));
watch([route, routingPending], ([value, pending]) => {
  if (!pending) presentedStartId.value = value?.features[0]?.properties.fromId;
}, { immediate: true });
useRouteDragging({ map });
useMapInteractions(map);
useStreetViewMap(map);
const streetView = useStreetViewStore();
function cancelPicking(event: KeyboardEvent) { if (event.key === 'Escape') streetView.picking = false; }
watch(() => streetView.picking, picking => {
  if (picking) window.addEventListener('keydown', cancelPicking);
  else window.removeEventListener('keydown', cancelPicking);
});
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
.map-view { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; overflow: hidden; }
.map-view__stage { position: relative; flex: 1; min-height: 0; }
/* Street View mode: a crosshair everywhere, also over the route, which otherwise shows its drag hand. */
.map-view__stage--picking :deep(.maplibregl-canvas) { cursor: crosshair !important; }
.map-view__street-view[aria-pressed=true] { border-color: var(--accent); color: var(--accent); }
.map-view__canvas { position: absolute; inset: 0; }
/* Below the map rather than over it, so the map's own controls stay visible. */
.map-view__profile { --profile-height: 11rem; padding: .5rem 1rem .4rem; border-top: 1px solid var(--border); background: var(--surface); }
.map-view__status { position: absolute; top: .75rem; left: .75rem; right: 4.5rem; display: grid; justify-items: start; gap: .5rem; pointer-events: none; }
.map-view__status > * { max-width: 30rem; border-radius: var(--radius); box-shadow: var(--shadow); pointer-events: auto; }
.map-view__progress { padding: .45rem .75rem; background: var(--surface); font-size: .82rem; }
.map-view__tools { position: absolute; top: .75rem; right: .75rem; display: grid; gap: .5rem; }
.map-view__basemaps { margin: 0; padding: 0; border: 0; }
.map-view__basemaps + .map-view__basemaps { margin-top: .5rem; padding-top: .5rem; border-top: 1px solid var(--border); }
.map-view__basemaps legend { padding: .25rem 0; }
@media (max-width: 760px) {
  .map-view__status { top: .5rem; left: .5rem; }
  .map-view__tools { top: .5rem; right: .5rem; }
  .map-view__profile { --profile-height: 7.5rem; padding: .35rem .75rem .25rem; }
}
</style>

<template>
  <div class="map-view">
    <div class="map-view__stage" :class="{ 'map-view__stage--picking': streetView.picking || surfaceReporting, 'map-view__stage--overview': overview,
      'map-view__stage--offline': offline.active }">
      <div id="map" class="map-view__canvas" aria-label="Interaktive Karte" />
      <SegmentedRouteLayer v-if="map" :map="map" :route="initialRouting ? null : route" :former="routeStore.formerRoute" />
      <SurfaceFocusLayer v-if="map" :map="map" :focus="surfacePreview ?? framed" />
      <LoopSuggestionsLayer v-if="map" :map="map" :loops="loopSuggestions.suggestions" :highlighted="loopSuggestions.highlighted" :selected="loopSuggestions.selected"
        @highlight="index => loopSuggestions.highlighted = index" />
      <RouteProfileLayer v-if="map" :map="map" :focus="routeProfileFocus" />
      <OfflineAreasLayer v-if="map && offline.active" :map="map" />
      <div class="map-view__status">
        <span v-if="initialRouting" class="map-view__progress" role="status">Route wird berechnet …</span>
        <span v-if="surfaceEstimate" class="map-view__progress" role="status">
          Untergrund wird ermittelt … {{ surfaceEstimate.total ? Math.round(surfaceEstimate.completed / surfaceEstimate.total * 100) : 0 }} %</span>
        <span v-if="streetView.picking" class="map-view__progress" role="status">
          {{ streetView.missing ? 'Kein Street View hier' : 'Punkt auf der Karte wählen' }}<span class="map-view__escape"> · Esc beendet</span></span>
        <SurfaceReportCard v-if="surfaceSelection" />
        <span v-else-if="surfaceReporting" class="map-view__progress" role="status">
          {{ surfacePicking ? `Ende wählen · ${partLength}` : 'Anfang auf der Route wählen' }}<span class="map-view__escape"> · Esc beendet</span></span>
        <v-alert v-if="mapError" type="error" variant="flat">
          {{ mapError }}
          <div><v-btn class="mt-2" @click="retryBasemap">Erneut laden</v-btn></div>
        </v-alert>
      </div>
      <div class="map-view__tools">
        <MapMenu label="Kartenansicht" heading="Kartenansicht" :title="basemapTitle">
          <template #icon><IconStack2 :size="20" aria-hidden="true" /></template>
          <template #default="{ close }">
            <!-- A choice by pointer closes the menu; arrow keys (clicks with detail 0) only move the selection. -->
            <v-radio-group v-for="group in basemapGroups" :key="group.label" v-model="basemap" :label="group.label" name="basemap">
              <v-radio v-for="item in group.items" :key="item.id" :label="item.label" :value="item.id"
                @click="(event: MouseEvent) => event.detail && close()" />
            </v-radio-group>
            <div v-tooltip:start="{ text: 'Das Satellitenbild zeigt das Gelände schon selbst', disabled: basemap !== 'aerial' }" class="map-view__relief">
              <span class="map-menu__group">Darstellung</span>
              <v-checkbox v-model="hillshade" label="Geländerelief" :disabled="basemap === 'aerial'" />
            </div>
            <button type="button" class="map-view__offline" @click="close(); offline.open()">
              <IconMapDown :size="18" aria-hidden="true" />Offline-Gebiete</button>
          </template>
        </MapMenu>
        <CyclingOverlays :map="map" />
        <v-map-button v-if="!offline.active" v-tooltip:start="'Street View: Punkt auf der Karte wählen'" :active="streetView.picking"
          :aria-pressed="streetView.picking" aria-label="Street View" @click="streetView.picking = !streetView.picking">
          <IconMan :size="20" aria-hidden="true" />
        </v-map-button>
        <v-map-button v-if="route && !offline.active" v-tooltip:start="'Auf Route zoomen'" aria-label="Auf Route zoomen" @click="fitRoute">
          <IconZoomScan :size="20" aria-hidden="true" />
        </v-map-button>
      </div>
      <MapNavigation class="map-view__navigation" :map="map" />
      <StreetViewPanel v-if="streetView.location" />
    </div>
    <ElevationProfile v-show="route && !offline.active" class="map-view__profile" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouteStore } from '@/stores/route.store';
import { showOnMap } from '@/utils/map-fit';
import { formatLength } from '@/utils/format';
import { pathMeters, type Coord } from '@/domain/route-model';
import { IconMan, IconMapDown, IconStack2, IconZoomScan } from '@/components/icons';
import { useMap } from '@/composables/useEditorMap';
import { useMapInteractions } from '@/composables/useMapInteractions';
import { useStreetViewMap } from '@/composables/useStreetViewMap';
import { useMarkerWatches } from '@/composables/useMarkerWatches';
import { useRouteDragging } from '@/composables/useRouteDragging';
import SegmentedRouteLayer from '@/components/map/SegmentedRouteLayer.vue';
import SurfaceFocusLayer from '@/components/map/SurfaceFocusLayer.vue';
import SurfaceReportCard from '@/components/map/SurfaceReportCard.vue';
import LoopSuggestionsLayer from '@/components/map/LoopSuggestionsLayer.vue';
import { useLoopSuggestionsStore } from '@/stores/loop-suggestions.store';
import { useRouteProfileStore } from '@/stores/route-profile.store';
import { routeStyle } from '@/config/mapStyle';
import RouteProfileLayer from '@/components/map/RouteProfileLayer.vue';
import OfflineAreasLayer from '@/components/map/OfflineAreasLayer.vue';
import { useOfflineAreasStore } from '@/stores/offline-areas.store';
import '@/services/offline-geocoding';
import CyclingOverlays from '@/components/map/CyclingOverlays.vue';
import ElevationProfile from '@/components/ui/ElevationProfile.vue';
import MapMenu from '@/components/map/MapMenu.vue';
import MapNavigation from '@/components/map/MapNavigation.vue';
import StreetViewPanel from '@/components/map/StreetViewPanel.vue';
import { useStreetViewStore } from '@/stores/street-view.store';
import { onlineBasemaps } from '@/config/online-basemaps';
import { localBasemaps, type EditorBasemap } from '@/config/basemaps';

const { map, basemap, hillshade, mapError, retryBasemap } = useMap('map', 'map-credits');
const basemapGroups: { label: string; items: readonly { id: EditorBasemap; label: string }[] }[] = [
  { label: 'Eigene Karten · Europa', items: localBasemaps },
  { label: 'Online · Internet erforderlich', items: onlineBasemaps },
];
const basemapTitle = computed(() =>
  `Kartenansicht: ${basemapGroups.flatMap(group => group.items).find(item => item.id === basemap.value)?.label}`);
const { focus: routeProfileFocus, rangeCoordinates, range, track: profileTrack } = storeToRefs(useRouteProfileStore());
// The stretch the profile zooms into, in the markers' ink.
const profileRange = computed(() => rangeCoordinates.value && { coordinates: rangeCoordinates.value, color: routeStyle.waiting });
const routeStore = useRouteStore();
const { route, waypoints, routingPending, focusedSurface, surfaceReporting, surfacesReportable, surfacePicking, surfacePreview,
  surfaceSelection, surfaceEstimate, fitRequest, shownSection } = storeToRefs(routeStore);
const partLength = computed(() => formatLength(pathMeters(surfacePreview.value?.coordinates ?? [])));
const loopSuggestions = useLoopSuggestionsStore();
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
// Street View and reporting a surface both take clicks on the map; starting one ends the other.
watch(() => streetView.picking, on => { if (on) routeStore.setSurfaceReporting(false); });
watch(surfaceReporting, on => { if (on) streetView.picking = false; });
watch(surfacesReportable, value => { if (!value) routeStore.setSurfaceReporting(false); });
function cancelPicking(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  streetView.picking = false;
  routeStore.setSurfaceReporting(false);
}
watch(() => streetView.picking || surfaceReporting.value, picking => {
  if (picking) window.addEventListener('keydown', cancelPicking);
  else window.removeEventListener('keydown', cancelPicking);
});
useMarkerWatches(map);
// Choosing offline areas shows all of them; leaving returns to the view before. Street View ends meanwhile.
const offline = useOfflineAreasStore();
void offline.init().catch(() => {});
let viewBefore: { center: [number, number]; zoom: number } | null = null;
watch(() => offline.active, on => {
  const instance = map.value;
  if (!instance) return;
  if (on) {
    streetView.picking = false;
    viewBefore = { center: instance.getCenter().toArray() as [number, number], zoom: instance.getZoom() };
    instance.fitBounds([[5, 45], [20, 50]], { padding: 24, duration: 600 });
  } else if (viewBefore) instance.easeTo({ ...viewBefore, duration: 600 });
});
// Zoomed far out, shaping points (every 5 km on an imported track) would merge into a chain; they show from zoom 11.
const overview = ref(false);
watch(map, instance => instance?.on('zoom', () => { overview.value = instance.getZoom() < 11; }));
watch(map, instance => {
  if (instance) instance.once('load', () => {
    if (route.value) fitRoute();
  });
});
// On phones the sheet makes way for an opened route, so the map grows before the fit holds. The route itself arrives
// later and can reach beyond its stops, and the profile appears with it: once calculated, it is fitted again.
let fitWhenRouted = false;
watch(fitRequest, () => {
  fitWhenRouted = true;
  fitRoute();
});
watch([route, routingPending], ([value, pending]) => {
  if (!fitWhenRouted || pending || !value?.features.length || !map.value) return;
  fitWhenRouted = false;
  fitRoute();
});
watch(shownSection, shown => {
  const leg = shown && routeStore.legs[shown.legId];
  if (map.value && leg) showOnMap(map.value, leg.coordinates);
});
// A stretch chosen among the surfaces or in the profile is framed. Let go, the whole route shows again, unless the
// route changed with it (the map then stays where the editing is). A stretch being reported stays where it was tapped.
const framed = computed(() => focusedSurface.value ?? profileRange.value);
// A recomputed focus (another leg routed meanwhile) is the same stretch.
const framedKey = computed(() => focusedSurface.value?.id ?? (range.value && `${range.value.from}:${range.value.to}`));
watch([framedKey, profileTrack], ([key, now], [before, then]) => {
  if (!map.value || key === before) return;
  if (framed.value) showOnMap(map.value, framed.value.coordinates);
  else if (before && now && now === then && !surfaceReporting.value) fitRoute();
});
function fitRoute() {
  if (!map.value) return;
  const stops = waypoints.value.flatMap(stop => stop.coord ? [stop.coord] : []);
  showOnMap(map.value, stops, ...(route.value?.features ?? []).map(feature => feature.geometry.coordinates as Coord[]));
}
</script>

<style scoped>
.map-view { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; overflow: hidden; }
.map-view__stage { position: relative; flex: 1; min-height: 0; }
/* Street View mode: a crosshair everywhere, also over the route, which otherwise shows its drag hand. */
.map-view__stage--picking :deep(.maplibregl-canvas) { cursor: crosshair !important; }
.map-view__stage--overview :deep(.route-marker--shape) { display: none; }
.map-view__canvas { position: absolute; inset: 0; }
/* Below the map rather than over it, so the map's own controls stay visible. */
/* Grows with the window, so climbs on long routes stay readable; phones keep a compact profile for the map's sake. The
   profile and the controls over the map keep the sidebar's margin from every edge. */
.map-view__profile { --profile-height: clamp(11rem, 28vh, 18rem); padding: var(--space-3) var(--gutter); border-top: 1px solid var(--border); background: var(--surface); }
.map-view__status { position: absolute; top: var(--gutter); left: var(--gutter); right: calc(2 * var(--gutter) + 40px); display: grid; justify-items: start; gap: var(--space-2); pointer-events: none; }
.map-view__status > * { max-width: 30rem; border-radius: var(--radius); box-shadow: var(--shadow); pointer-events: auto; }
.map-view__progress { padding: .45rem .75rem; background: var(--surface); font-size: .875rem; }
/* Touch screens have no Escape key; the pressed button ends the mode there. */
@media (hover: none) { .map-view__escape { display: none; } }
.map-view__tools { position: absolute; top: var(--gutter); right: var(--gutter); display: grid; gap: var(--space-2); }
.map-view__navigation { position: absolute; right: var(--gutter); bottom: var(--gutter); }
/* While choosing offline areas the route stays in view, but its stops do not take clicks. */
.map-view__stage--offline :deep(.maplibregl-marker) { display: none; }
/* An entry as the menu's choices: its glyph on the margin, its label 36 px in, a 40 px row whose hover reaches 8 px past. */
.map-view__offline { display: flex; align-items: center; gap: var(--space-3); width: calc(100% + 2 * var(--space-2)); height: 40px;
  margin: var(--space-2) calc(-1 * var(--space-2)) 0; padding: 0 var(--space-2); border: 0; border-radius: var(--radius); background: none;
  color: var(--text); font: inherit; font-size: .875rem; cursor: pointer; }
.map-view__offline svg { flex: none; margin-inline: 3px; color: var(--text-muted); }
.map-view__offline:hover { background: rgba(var(--v-theme-on-surface), var(--v-hover-opacity)); }
/* The relief applies to every map, so it stands apart from the online group above it. */
.map-view__relief { margin-top: var(--space-2); }
/* The scale as a thin ink bracket with its distance above, a white halo keeping both readable on any map. */
.map-view__canvas :deep(.maplibregl-ctrl-bottom-left .maplibregl-ctrl-scale) { position: relative; margin: 0 0 var(--gutter) var(--gutter);
  padding: 0 0 8px 2px; border: 0; background: none; color: var(--text); font: 500 .6875rem/1 var(--font);
  text-shadow: 0 0 2px #fff, 0 0 2px #fff, 0 0 3px #fff; }
.map-view__canvas :deep(.maplibregl-ctrl-bottom-left .maplibregl-ctrl-scale)::after { content: ''; position: absolute; inset: auto 0 0; height: 5px;
  border: 1.5px solid var(--text); border-top: 0; filter: drop-shadow(0 0 1px #fff); }
@media (max-width: 760px) {
  .map-view__profile { --profile-height: 7.5rem; padding: var(--space-2) var(--gutter); }
}
</style>

<template>
  <div class="map-view">
    <div class="map-view__stage" :class="{ 'map-view__stage--picking': streetView.picking || surfaceReporting, 'map-view__stage--overview': overview }">
      <div id="map" class="map-view__canvas" aria-label="Interaktive Karte" />
      <SegmentedRouteLayer v-if="map" :map="map" :route="initialRouting ? null : route" :former="routeStore.formerRoute" />
      <GpxReferenceLayer v-if="map" :map="map" :track="gpxTrack" :visible="gpxVisible" :fit-request="gpxFitRequest" />
      <SurfaceFocusLayer v-if="map" :map="map" :focus="surfacePreview ?? focusedSurface ?? profileRange" :frame="!surfacePreview" />
      <LoopSuggestionsLayer v-if="map" :map="map" :loops="loopSuggestions.suggestions" :highlighted="loopSuggestions.highlighted" :selected="loopSuggestions.selected"
        @highlight="index => loopSuggestions.highlighted = index" />
      <RouteProfileLayer v-if="map" :map="map" :focus="routeProfileFocus" />
      <div class="map-view__status">
        <span v-if="initialRouting" class="map-view__progress" role="status">Route wird berechnet …</span>
        <span v-if="surfaceEstimate" class="map-view__progress" role="status">
          Beläge werden ermittelt … {{ surfaceEstimate.total ? Math.round(surfaceEstimate.completed / surfaceEstimate.total * 100) : 0 }} %</span>
        <span v-if="streetView.picking" class="map-view__progress" role="status">
          {{ streetView.missing ? 'Kein Street View hier' : 'Punkt auf der Karte wählen' }}<span class="map-view__escape"> · Esc bricht ab</span></span>
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
            <div v-tooltip:start="{ text: 'Das Satellitenbild zeigt das Gelände schon selbst', disabled: basemap !== 'aerial' }">
              <v-switch v-model="hillshade" label="Geländerelief" :disabled="basemap === 'aerial'" />
            </div>
          </template>
        </MapMenu>
        <CyclingOverlays :map="map" />
        <v-map-button v-tooltip:start="'Street View: Punkt auf der Karte wählen'" :active="streetView.picking"
          :aria-pressed="streetView.picking" aria-label="Street View" @click="pickStreetView(!streetView.picking)">
          <IconMan :size="20" aria-hidden="true" />
        </v-map-button>
        <v-map-button v-if="reportable" v-tooltip:start="'Belag melden'" :active="surfaceReporting" :aria-pressed="surfaceReporting"
          aria-label="Belag melden" @click="reportSurfaces(!surfaceReporting)">
          <IconBrush :size="20" aria-hidden="true" />
        </v-map-button>
        <v-map-button v-if="route" v-tooltip:start="'Auf Route zoomen'" aria-label="Auf Route zoomen" @click="fitRoute">
          <IconFocus2 :size="20" aria-hidden="true" />
        </v-map-button>
      </div>
      <MapNavigation class="map-view__navigation" :map="map" />
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
import { fitAndSettle } from '@/utils/map-fit';
import { formatLength } from '@/utils/format';
import { pathMeters } from '@/domain/route-model';
import { IconBrush, IconFocus2, IconMan, IconStack2 } from '@/components/icons';
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
import GpxReferenceLayer from '@/components/map/GpxReferenceLayer.vue';
import { useGpxReferenceStore } from '@/stores/gpx-reference.store';
import { useRouteProfileStore } from '@/stores/route-profile.store';
import { routeStyle } from '@/config/mapStyle';
import RouteProfileLayer from '@/components/map/RouteProfileLayer.vue';
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
const { focus: routeProfileFocus, rangeCoordinates } = storeToRefs(useRouteProfileStore());
// The stretch the profile zooms into, in the markers' ink.
const profileRange = computed(() => rangeCoordinates.value && { coordinates: rangeCoordinates.value, color: routeStyle.waiting });
const routeStore = useRouteStore();
const { route, legs, waypoints, routingPending, focusedSurface, surfaceReporting, surfacePicking, surfacePreview, surfaceSelection,
  surfaceEstimate, fitRequest, shownSection } = storeToRefs(routeStore);
const partLength = computed(() => formatLength(pathMeters(surfacePreview.value?.coordinates ?? [])));
const loopSuggestions = useLoopSuggestionsStore();
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
// Street View and reporting a surface both take clicks on the map; one ends the other.
function pickStreetView(on: boolean) {
  streetView.picking = on;
  if (on) routeStore.setSurfaceReporting(false);
}
function reportSurfaces(on: boolean) {
  routeStore.setSurfaceReporting(on);
  if (on) streetView.picking = false;
}
// Only planned legs have their roads' surfaces; recorded tracks lie beside them. Reports are saved by the planner's
// development server (scripts/surface-corrections.ts), which a built planner lacks.
const reportable = computed(() => import.meta.env.DEV && Object.values(legs.value).some(leg => leg.status === 'routed' && !leg.recorded));
watch(reportable, value => { if (!value) reportSurfaces(false); });
function cancelPicking(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  pickStreetView(false);
  reportSurfaces(false);
}
watch(() => streetView.picking || surfaceReporting.value, picking => {
  if (picking) window.addEventListener('keydown', cancelPicking);
  else window.removeEventListener('keydown', cancelPicking);
});
useMarkerWatches(map);
// Zoomed far out, shaping points (every 5 km on an imported track) would merge into a chain; they show from zoom 11.
const overview = ref(false);
watch(map, instance => instance?.on('zoom', () => { overview.value = instance.getZoom() < 11; }));
watch(map, instance => {
  if (instance) instance.once('load', () => {
    if (gpxTrack.value && gpxVisible.value) instance.fitBounds(gpxTrack.value.bounds, { padding: 50, maxZoom: 16, duration: 0 });
    else if (route.value) fitRoute();
  });
});
// On phones the sheet makes way for an opened route, so the map grows before the fit holds.
watch(fitRequest, () => { if (map.value) fitAndSettle(map.value, fitRoute); });
watch(shownSection, shown => {
  const leg = shown && routeStore.legs[shown.legId];
  if (!map.value || !leg) return;
  const bounds = new LngLatBounds();
  for (const coord of leg.coordinates) bounds.extend([coord[0], coord[1]]);
  fitAndSettle(map.value, () => map.value?.fitBounds(bounds, { padding: 80, maxZoom: 15, maxDuration: 1500 }));
});
function fitRoute() {
  const bounds = new LngLatBounds();
  for (const stop of waypoints.value) if (stop.coord) bounds.extend(stop.coord);
  for (const feature of route.value?.features ?? []) {
    for (const coord of feature.geometry.coordinates) bounds.extend([coord[0], coord[1]]);
  }
  // Nearby it glides; a route far away (an opened one in another region) appears at once.
  if (!bounds.isEmpty()) map.value?.fitBounds(bounds, { padding: 60, maxZoom: 16, maxDuration: 1500 });
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
.map-view__progress { padding: .45rem .75rem; background: var(--surface); font-size: .82rem; }
/* Touch screens have no Escape key; the pressed button ends the mode there. */
@media (hover: none) { .map-view__escape { display: none; } }
.map-view__tools { position: absolute; top: var(--gutter); right: var(--gutter); display: grid; gap: var(--space-2); }
.map-view__navigation { position: absolute; right: var(--gutter); bottom: var(--gutter); }
.map-view__canvas :deep(.maplibregl-ctrl-bottom-left .maplibregl-ctrl-scale) { margin: 0 0 var(--gutter) var(--gutter); }
@media (max-width: 760px) {
  .map-view__profile { --profile-height: 7.5rem; padding: var(--space-2) var(--gutter); }
}
</style>

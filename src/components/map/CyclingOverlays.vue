<template>
  <MapMenu class="cycling-controls" heading="Rad-Infos"
    :label="error ? 'Rad-Infos, Fehler beim Laden' : `Rad-Infos, ${selected.length} angezeigt`">
    <template #icon>
      <v-badge :model-value="Boolean(error || selected.length)" :content="error ? '!' : selected.length" :color="error ? 'error' : 'primary'" floating>
        <IconBike :size="20" aria-hidden="true" />
      </v-badge>
    </template>
    <v-checkbox v-for="item in cyclingOverlays" :key="item.id" v-model="selected" :value="item.id">
      <template #label>
        <span class="cycling-controls__label">{{ item.label }}
          <i :class="item.id === 'cycleways' || item.id === 'routes' ? 'swatch' : 'cycling-controls__dot'" :style="{ background: item.color }" aria-hidden="true" /></span>
      </template>
    </v-checkbox>
    <v-alert v-if="error" type="error">
      {{ error }}
      <div><v-btn class="mt-2" @click="retry">Erneut laden</v-btn></div>
    </v-alert>
  </MapMenu>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Popup, type ErrorEvent, type Map, type MapMouseEvent, type GeoJSONSource, type FilterSpecification } from 'maplibre-gl';
import { IconBike } from '@/components/icons';
import MapMenu from '@/components/map/MapMenu.vue';
import { useStreetViewStore } from '@/stores/street-view.store';
import { cyclingOverlays, cyclingPoiLayers, poiHitBox, type CyclingOverlay } from '@/config/cycling-overlays';

const props = defineProps<{ map: Map | null }>();
const storageKey = 'richiroute.cycling-overlays';
function initial(): CyclingOverlay[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (Array.isArray(value)) return cyclingOverlays.filter(item => value.includes(item.id)).map(item => item.id);
  } catch { /* Use defaults when browser storage is unavailable. */ }
  return ['water', 'cycleways'];
}
const selected = ref<CyclingOverlay[]>(initial());
const error = ref('');
const needsPoints = computed(() => selected.value.some(id => ['water', 'repair', 'stations'].includes(id)));
let installed = false, request: AbortController | undefined, popup: Popup | undefined;
const empty = { type: 'FeatureCollection' as const, features: [] };

function install() {
  const map = props.map;
  if (installed || !map?.getSource('basemap-vector-europe')) return;
  installed = true;
  map.addSource('cycling-points', { type: 'geojson', data: empty });
  for (const item of cyclingOverlays) {
    const id = `cycling-${item.id}`;
    const layout = { visibility: selected.value.includes(item.id) ? 'visible' as const : 'none' as const };
    if (item.id === 'cycleways') {
      for (const casing of [true, false]) map.addLayer({
        id: casing ? `${id}-casing` : id, type: 'line', source: 'basemap-vector-europe', 'source-layer': 'roads', minzoom: item.minzoom,
        filter: ['==', ['get', 'kind_detail'], 'cycleway'], layout: { ...layout, 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': casing ? '#ffffff' : item.color,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, casing ? 3 : 1.5, 17, casing ? 6 : 3.5] },
      }, 'basemap-overlay-anchor');
      continue;
    }
    if (item.id === 'routes') {
      map.addSource('cycling-routes', { type: 'raster', tiles: ['https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 18,
        attribution: 'Radrouten: <a href="https://cycling.waymarkedtrails.org">Waymarked Trails</a> (CC BY-SA)' });
      map.addLayer({ id, type: 'raster', source: 'cycling-routes', layout, paint: { 'raster-fade-duration': 100 } }, 'basemap-overlay-anchor');
      continue;
    }
    const local = item.id !== 'food';
    const source = local ? { source: 'cycling-points' } : { source: 'basemap-vector-europe', 'source-layer': 'pois' };
    const kinds = item.id === 'water' ? ['water'] : item.id === 'repair' ? ['repair', 'shop']
      : item.id === 'food' ? ['supermarket', 'bakery', 'cafe', 'convenience', 'grocery'] : ['station'];
    const filter: FilterSpecification = ['in', ['get', 'kind'], ['literal', kinds]];
    map.addLayer({ id, type: 'circle', ...source, minzoom: item.minzoom, filter, layout,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 15, 5, 17, 6], 'circle-color': item.color,
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 15, 2] } }, 'map-labels-top');
    map.addLayer({ id: `${id}-labels`, type: 'symbol', ...source, minzoom: Math.max(14, item.minzoom), filter,
      layout: { ...layout, 'text-field': ['coalesce', ['get', 'name'], item.label], 'text-font': ['Noto Sans Regular'],
        'text-size': 11, 'text-anchor': 'top', 'text-offset': [0, .9], 'text-max-width': 12 },
      paint: { 'text-color': '#243b32', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } }, 'map-labels-top');
  }
  void loadPoints();
}
// Radrouten come from an online server; its tiles reload with the points.
function retry() {
  if (props.map?.getSource('cycling-routes')) props.map.refreshTiles('cycling-routes');
  void loadPoints();
}
function tileError(event: ErrorEvent & { sourceId?: string }) {
  if (event.sourceId === 'cycling-routes' && selected.value.includes('routes')) error.value = 'Radrouten konnten nicht geladen werden.';
}
async function loadPoints() {
  request?.abort(); request = undefined; error.value = '';
  const map = props.map;
  if (!map || !installed) return;
  const source = map.getSource<GeoJSONSource>('cycling-points');
  if (!needsPoints.value || map.getZoom() < 12) { source?.setData(empty); return; }
  const bounds = map.getBounds();
  const west = bounds.getWest(), east = bounds.getEast(), south = bounds.getSouth(), north = bounds.getNorth();
  if (west < -180 || east > 180 || (east - west) * (north - south) > 4) { source?.setData(empty); return; }
  const controller = new AbortController(); request = controller;
  try {
    const response = await fetch(`/maps/cycling.json?bbox=${[west, south, east, north].map(v => v.toFixed(6)).join(',')}`,
      { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (controller.signal.aborted) return;
    source?.setData(data);
  } catch {
    if (controller.signal.aborted) return;
    source?.setData(empty);
    error.value = 'Rad-Infos konnten nicht geladen werden.';
  } finally { if (request === controller) request = undefined; }
}
const streetView = useStreetViewStore();
function inspect(event: MapMouseEvent) {
  const map = props.map;
  if (!installed || !map || streetView.picking) return;
  const feature = map.queryRenderedFeatures(poiHitBox(event.point), { layers: cyclingPoiLayers })[0];
  if (!feature || feature.geometry.type !== 'Point') return;
  const p = feature.properties, kind = p.kind;
  const title = kind === 'water' ? 'Trinkwasser' : kind === 'repair' ? 'Reparaturstation' : kind === 'shop' ? 'Fahrradgeschäft'
    : kind === 'station' ? 'Bahnstation' : 'Verpflegung';
  const content = document.createElement('div'); content.className = 'cycling-popup';
  const add = (tag: string, text: string) => { const node = document.createElement(tag); node.textContent = text; content.append(node); };
  add('strong', p.name || title);
  if (p.name) add('p', title);
  if (p.opening_hours) add('p', `Öffnungszeiten: ${p.opening_hours}`);
  if (p.seasonal && p.seasonal !== 'no') add('p', p.seasonal === 'yes' ? 'Saisonal verfügbar' : `Saison: ${p.seasonal}`);
  if (p.access && !['yes', 'public', 'permissive'].includes(p.access)) add('p', `Zugang: ${p.access}`);
  if (p.fee) add('p', p.fee === 'no' ? 'Kostenlos' : `Kostenpflichtig: ${p.fee}`);
  if (kind === 'water') add('p', 'In OpenStreetMap als Trinkwasser erfasst. Verfügbarkeit vor Ort prüfen.');
  if (p.description) add('p', p.description);
  if (p.osmId && ['node', 'way', 'relation'].includes(p.osmType)) {
    const link = document.createElement('a');
    link.textContent = 'Eintrag auf OpenStreetMap'; link.href = `https://www.openstreetmap.org/${p.osmType}/${p.osmId}`;
    link.target = '_blank'; link.rel = 'noopener noreferrer'; content.append(link);
  }
  popup?.remove();
  popup = new Popup({ maxWidth: '270px' }).setLngLat(event.lngLat).setDOMContent(content).addTo(map);
}
watch(selected, () => {
  popup?.remove();
  for (const item of cyclingOverlays) for (const suffix of ['', '-labels', '-casing']) {
    const id = `cycling-${item.id}${suffix}`;
    if (props.map?.getLayer(id)) props.map.setLayoutProperty(id, 'visibility', selected.value.includes(item.id) ? 'visible' : 'none');
  }
  try { localStorage.setItem(storageKey, JSON.stringify(selected.value)); } catch { /* Selection still works without storage. */ }
  void loadPoints();
});
function detach(map: Map | null | undefined) {
  map?.off('styledata', install); map?.off('moveend', loadPoints); map?.off('click', inspect); map?.off('error', tileError);
  request?.abort(); popup?.remove();
}
watch(() => props.map, (map, previous) => {
  detach(previous); installed = false;
  map?.on('styledata', install); map?.on('moveend', loadPoints); map?.on('click', inspect); map?.on('error', tileError); install();
}, { immediate: true });
onBeforeUnmount(() => detach(props.map));
</script>

<style scoped>
.cycling-controls__label { display: inline-flex; align-items: center; gap: .5rem; }
.cycling-controls__dot { width: .6rem; height: .6rem; border-radius: 50%; flex-shrink: 0; }
</style>

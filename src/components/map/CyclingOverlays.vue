<template>
  <MapMenu class="cycling-controls" heading="Rad-Infos"
    :label="error ? 'Rad-Infos, Fehler beim Laden' : `Rad-Infos, ${selected.length} angezeigt`">
    <template #icon>
      <IconBike :size="20" aria-hidden="true" />
      <span v-if="error" class="cycling-controls__badge cycling-controls__badge--alert" aria-hidden="true">!</span>
      <span v-else-if="selected.length" class="cycling-controls__badge" aria-hidden="true">{{ selected.length }}</span>
    </template>
    <label v-for="item in cyclingOverlays" :key="item.id" class="option">
      <input v-model="selected" type="checkbox" :value="item.id" />
      <span>{{ item.label }}</span>
      <i :class="item.id === 'cycleways' ? 'swatch' : 'cycling-controls__dot'" :style="{ background: item.color }" aria-hidden="true" />
    </label>
    <p v-if="error" class="notice notice--error" role="alert">{{ error }} <button type="button" class="btn" @click="loadPoints">Erneut laden</button></p>
  </MapMenu>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Popup, type Map, type MapMouseEvent, type GeoJSONSource, type FilterSpecification } from 'maplibre-gl';
import { IconBike } from '@/components/icons';
import MapMenu from '@/components/map/MapMenu.vue';
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
  if (installed || !map?.getLayer('roads')) return;
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
function inspect(event: MapMouseEvent) {
  const map = props.map;
  if (!installed || !map) return;
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
  map?.off('styledata', install); map?.off('moveend', loadPoints); map?.off('click', inspect);
  request?.abort(); popup?.remove();
}
watch(() => props.map, (map, previous) => {
  detach(previous); installed = false;
  map?.on('styledata', install); map?.on('moveend', loadPoints); map?.on('click', inspect); install();
}, { immediate: true });
onBeforeUnmount(() => detach(props.map));
</script>

<style scoped>
.cycling-controls__badge { position: absolute; top: -.35rem; right: -.35rem; min-width: 1.1rem; padding: 0 .25rem; border: 2px solid var(--surface);
  border-radius: 999px; background: var(--accent); color: #fff; font-size: .65rem; font-weight: 700; line-height: 1rem; font-variant-numeric: tabular-nums; }
.cycling-controls__badge--alert { background: var(--danger); }
.option > i { margin-left: auto; }
.cycling-controls__dot { width: .6rem; height: .6rem; border-radius: 50%; flex-shrink: 0; }
.notice { margin-top: .5rem; }
</style>

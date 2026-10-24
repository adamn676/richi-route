<template>
  <details class="cycling-controls" @keydown.esc="close">
    <summary>Rad-Infos <span v-if="error" title="Einige Rad-Infos konnten nicht geladen werden">!</span><span v-else-if="selected.length">{{ selected.length }}</span></summary>
    <div class="cycling-controls__panel">
      <fieldset>
        <legend>Auf der Karte anzeigen</legend>
        <label v-for="item in cyclingOverlays" :key="item.id">
          <input v-model="selected" type="checkbox" :value="item.id" />
          <span class="cycling-controls__swatch" :class="{ 'cycling-controls__swatch--line': item.id === 'cycleways' }" :style="{ background: item.color }" />
          <span>{{ item.label }}<small>{{ item.hint }}</small></span>
        </label>
      </fieldset>
      <p v-if="zoom < 12">Zum Anzeigen näher heranzoomen.</p>
      <p v-else-if="zoom < 14 && selected.includes('food')">Verpflegung erscheint ab Zoom 14.</p>
      <p v-if="loading" role="status">Rad-Infos werden geladen …</p>
      <p v-if="error" role="alert">{{ error }} <button type="button" @click="loadPoints">Erneut laden</button></p>
      <p v-else-if="truncated">Viele Treffer. Für weitere Details näher heranzoomen.</p>
      <p v-if="updated" class="cycling-controls__date">Trinkwasser, Radservice & Bahnhöfe: {{ coverage }} · {{ new Date(updated).toLocaleDateString('de-AT') }}</p>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Popup, type Map, type MapMouseEvent, type GeoJSONSource, type FilterSpecification } from 'maplibre-gl';
import { cyclingOverlays, cyclingPoiLayers, type CyclingOverlay } from '@/config/cycling-overlays';

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
const zoom = ref(0), loading = ref(false), error = ref(''), truncated = ref(false), updated = ref('');
const coverage = ref('');
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
      paint: { 'circle-radius': 6, 'circle-color': item.color, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } }, 'map-labels-top');
    map.addLayer({ id: `${id}-labels`, type: 'symbol', ...source, minzoom: Math.max(14, item.minzoom), filter,
      layout: { ...layout, 'text-field': ['coalesce', ['get', 'name'], item.label], 'text-font': ['Noto Sans Regular'],
        'text-size': 11, 'text-anchor': 'top', 'text-offset': [0, .9], 'text-max-width': 12 },
      paint: { 'text-color': '#243b32', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } }, 'map-labels-top');
  }
  void loadPoints();
}
async function loadPoints() {
  request?.abort(); request = undefined; loading.value = false; error.value = ''; truncated.value = false;
  const map = props.map;
  if (!map) return;
  zoom.value = map.getZoom();
  if (!installed) return;
  const source = map.getSource<GeoJSONSource>('cycling-points');
  if (!needsPoints.value || zoom.value < 12) { source?.setData(empty); return; }
  const bounds = map.getBounds();
  const west = bounds.getWest(), east = bounds.getEast(), south = bounds.getSouth(), north = bounds.getNorth();
  if (west < -180 || east > 180 || (east - west) * (north - south) > 4) { source?.setData(empty); return; }
  const controller = new AbortController(); request = controller; loading.value = true;
  try {
    const response = await fetch(`/maps/cycling.json?bbox=${[west, south, east, north].map(v => v.toFixed(6)).join(',')}`,
      { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (controller.signal.aborted) return;
    source?.setData(data); truncated.value = data.truncated; updated.value = data.updated; coverage.value = data.coverage;
  } catch {
    if (controller.signal.aborted) return;
    source?.setData(empty);
    error.value = 'Trinkwasser, Radservice und Bahnhöfe konnten nicht geladen werden.';
  } finally { if (request === controller) { loading.value = false; request = undefined; } }
}
function inspect(event: MapMouseEvent) {
  const map = props.map;
  if (!installed || !map) return;
  const feature = map.queryRenderedFeatures(event.point, { layers: cyclingPoiLayers })[0];
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
function close(event: KeyboardEvent) {
  const details = event.currentTarget as HTMLDetailsElement;
  details.open = false; details.querySelector('summary')?.focus();
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
.cycling-controls { color: #243b32; }
summary { cursor: pointer; padding: .45rem; border: 1px solid #cddbd9; border-radius: .3rem; list-style: none; }
summary::after { content: '⌄'; margin-left: .55rem; }
summary span { margin-left: .25rem; color: #086c78; font-variant-numeric: tabular-nums; }
.cycling-controls__panel { position: absolute; top: calc(100% + .5rem); left: 0; z-index: 5; width: min(290px, calc(100vw - 2rem)); padding: .85rem; border: 1px solid #dfe5e1; border-radius: .5rem; background: white; box-shadow: 0 5px 18px #19343c26; max-height: min(55dvh, 420px); overflow-y: auto; }
fieldset { padding: 0; margin: 0; border: 0; }
legend { font-size: .8rem; font-weight: 650; margin-bottom: .5rem; }
label { display: flex; align-items: flex-start; gap: .55rem; padding: .55rem 0; cursor: pointer; font-size: .8rem; }
input { margin: .2rem 0 0; accent-color: #096e69; width: 1rem; height: 1rem; flex-shrink: 0; }
small { display: block; margin-top: .2rem; color: #64736d; line-height: 1.4; font-size: .7rem; }
.cycling-controls__swatch { width: .55rem; height: .55rem; margin-top: .35rem; border-radius: 50%; flex-shrink: 0; }
.cycling-controls__swatch--line { height: .2rem; margin-top: .5rem; border-radius: 0; }
p { margin: .6rem 0 0; font-size: .72rem; line-height: 1.45; }
.cycling-controls__date { color: #64736d; }
@media (max-width: 760px) { .cycling-controls__panel { max-height: min(40dvh, calc(100dvh - 350px)); } }
</style>

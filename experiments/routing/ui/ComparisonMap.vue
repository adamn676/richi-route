<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map, RasterTileSource, VectorTileSource } from 'maplibre-gl';
import type { FeatureCollection, LineString, Position } from 'geojson';
import type { Result, RoutePoint } from './types';
import { basemapOptions, basemapSources, initialBasemap } from '../../../src/config/basemaps';
import { surfaceColor, surfaceLabel, type RouteInspection } from './route-inspection';
import { compareRouteGeometry } from '../route-comparison.mjs';

const props = defineProps<{ points: RoutePoint[]; routes: Result[]; highlighted: string; inspection?: RouteInspection | null; cursor?: number | null; section?: number | null; showSurfaces?: boolean }>();
const emit = defineEmits<{ section: [index: number] }>();
const container = ref<HTMLDivElement>();
const mapError = ref('');
const roadError = ref('');
const basemap = ref(initialBasemap());
const imageryError = ref('');
const imageryLoading = ref(basemap.value !== 'local');
const routeOpacity = ref(1);
const comparison = computed(() => compareRouteGeometry(props.routes));
const routeCount = computed(() => props.routes.filter(route => route.normalized).length);
const differenceIndex = ref(-1);
const engineNames = { graphhopper: 'GraphHopper', brouter: 'BRouter', ors: 'ORS' };
const selectedName = computed(() => {
  const selected = props.routes.find(route => route.id === props.highlighted);
  return selected ? engineNames[selected.engineId] : '';
});
const sharedLabels = computed(() => comparison.value.shared.map(ids => ids.map(id => {
  const route = props.routes.find(route => route.id === id)!;
  return engineNames[route.engineId];
}).join(' + ')));
let map: Map | undefined;
let markers: maplibregl.Marker[] = [];
let resize: ResizeObserver | undefined;
let roadCheck = 0;
let positionMarker: maplibregl.Marker | undefined;
const failedRoadTiles = new Set<string>();

function tileKey(event: object): string {
  if (!('tile' in event) || !event.tile || typeof event.tile !== 'object') return 'unknown';
  const tile = event.tile;
  if (!('tileID' in tile) || !tile.tileID || typeof tile.tileID !== 'object' || !('key' in tile.tileID)) return 'unknown';
  return String(tile.tileID.key);
}

async function checkRoadService() {
  const check = ++roadCheck;
  roadError.value = 'Some road details could not load. Retry map to reload them.';
  try {
    const response = await fetch('/api/map-status', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const status = await response.json();
    if (check !== roadCheck || !failedRoadTiles.size) return;
    roadError.value = status.available === false
      ? 'The local road service is not responding. Start it with npm run bench:up, then retry map. Saved routes remain available.'
      : 'The local road service is running, but some road details could not load. Retry map to reload them.';
  } catch { /* Keep the tile failure message when the service check is inconclusive. */ }
}

function retryMap() {
  roadCheck++;
  failedRoadTiles.clear();
  roadError.value = '';
  mapError.value = '';
  imageryError.value = '';
  imageryLoading.value = basemap.value !== 'local';
  map?.getSource<VectorTileSource>('streets')?.setTiles([`${location.origin}/tiles/{z}/{x}/{y}.mvt`]);
  for (const [id, source] of Object.entries(basemapSources)) {
    if (map?.getLayoutProperty(id, 'visibility') === 'visible') {
      map.getSource<RasterTileSource>(id)?.setTiles(source.tiles!);
    }
  }
  draw();
}

function setBasemap() {
  if (!map?.getLayer('basemap-street')) return;
  for (const name of ['street', 'aerial', 'labels']) {
    const visible = name === 'labels' ? basemap.value === 'aerial' : basemap.value === name;
    map.setLayoutProperty(`basemap-${name}`, 'visibility', visible ? 'visible' : 'none');
  }
  for (const layer of ['streets', 'streets-outline']) {
    map.setLayoutProperty(layer, 'visibility', basemap.value === 'local' ? 'visible' : 'none');
  }
}

function setRouteOpacity() {
  if (!map?.getLayer('comparison-lines')) return;
  for (const layer of ['comparison-lines', 'selected-route', 'surface-outline', 'surface-lines', 'section-highlight']) {
    map.setPaintProperty(layer, 'line-opacity', Number(routeOpacity.value));
  }
}

function inspectRoad(road: Record<string, unknown>, location: maplibregl.LngLat) {
  if (!map) return;
  const content = document.createElement('div');
  content.className = 'road-detail';
  const heading = document.createElement('strong');
  heading.textContent = String(road.street_name || road.street_ref || 'Unnamed road');
  content.append(heading);
  const details = document.createElement('dl');
  for (const [label, key] of [['Road type', 'road_class'], ['Surface', 'surface'], ['Smoothness', 'smoothness'], ['Bicycle access tag', 'bike_road_access']]) {
    const term = document.createElement('dt');
    term.textContent = label!;
    const value = document.createElement('dd');
    const raw = road[key!];
    value.textContent = !raw || raw === 'missing' || raw === 'other' ? 'Unknown' : String(raw).replace(/_/g, ' ');
    details.append(term, value);
  }
  content.append(details);
  const note = document.createElement('p');
  note.textContent = 'Local OpenStreetMap routing data. Unknown tags do not establish access or surface quality.';
  content.append(note);
  new maplibregl.Popup({ maxWidth: '290px' }).setLngLat(location).setDOMContent(content).addTo(map);
}

function fit() {
  if (!map) return;
  const coordinates: Position[] = props.routes.flatMap((route) => route.normalized?.geometry.coordinates ?? []);
  coordinates.push(...props.points.map((point) => point.coord));
  if (!coordinates.length) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const point of coordinates) bounds.extend([point[0]!, point[1]!]);
  map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 0 });
  differenceIndex.value = -1;
}

function nextDifference() {
  if (!map || !comparison.value.differences.length) return;
  differenceIndex.value = (differenceIndex.value + 1) % comparison.value.differences.length;
  const bounds = comparison.value.differences[differenceIndex.value]!.bounds;
  const controlsHeight = container.value?.parentElement?.querySelector('.map-tools')?.clientHeight ?? 0;
  const top = Math.min(map.getContainer().clientHeight / 2, controlsHeight + 24);
  map.fitBounds([[bounds[0]!, bounds[1]!], [bounds[2]!, bounds[3]!]], {
    padding: { top, bottom: 50, left: 50, right: 50 }, maxZoom: 18, duration: 0,
  });
}

function draw() {
  if (!map?.getSource('routes')) return;
  const data: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features: props.routes.filter((route) => route.normalized).map((route) => ({
      type: 'Feature', geometry: route.normalized!.geometry,
      properties: { id: route.id, engine: route.engineId },
    })),
  };
  (map.getSource('routes') as GeoJSONSource).setData(data);
  map.getSource<GeoJSONSource>('comparison')!.setData(comparison.value.data);
  map.setFilter('selected-route', ['==', ['get', 'id'], props.highlighted]);
  for (const marker of markers) marker.remove();
  markers = props.points.map((point, index) => {
    const element = document.createElement('div');
    element.className = `route-point ${point.role}`;
    element.textContent = String(index + 1);
    element.title = `${point.role === 'stop' ? 'Stop' : 'Shaping point'} ${index + 1}: ${point.coord.join(', ')}`;
    element.setAttribute('aria-label', element.title);
    return new maplibregl.Marker({ element }).setLngLat(point.coord).addTo(map!);
  });
  drawInspection();
}

function drawInspection() {
  if (!map?.getSource('surface-sections')) return;
  const inspection = props.inspection;
  const surfaceMode = !!(props.showSurfaces && inspection);
  const features = inspection?.sections.map((section, index) => ({
    type: 'Feature' as const,
    geometry: { type: 'LineString' as const, coordinates: inspection.coordinates.slice(section.fromIndex, section.toIndex + 1) },
    properties: { index, color: surfaceColor(section.surface), label: surfaceLabel(section.surface) },
  })) ?? [];
  map.getSource<GeoJSONSource>('surface-sections')!.setData({ type: 'FeatureCollection', features });
  map.getSource<GeoJSONSource>('selected-section')!.setData({
    type: 'FeatureCollection',
    features: props.section != null && features[props.section] ? [features[props.section]] : [],
  });
  for (const id of ['comparison-lines', 'selected-route']) {
    map.setLayoutProperty(id, 'visibility', surfaceMode ? 'none' : 'visible');
  }
  for (const id of ['surface-outline', 'surface-lines', 'section-highlight']) {
    map.setLayoutProperty(id, 'visibility', surfaceMode ? 'visible' : 'none');
  }
  drawCursor();
}

function drawCursor() {
  const coord = props.cursor != null ? props.inspection?.coordinates[props.cursor] : undefined;
  if (!map || !coord) { positionMarker?.remove(); positionMarker = undefined; return; }
  if (!positionMarker) {
    const element = document.createElement('div');
    element.className = 'inspection-position';
    element.setAttribute('aria-label', 'Selected position on route');
    positionMarker = new maplibregl.Marker({ element }).setLngLat(coord).addTo(map);
  } else positionMarker.setLngLat(coord);
}

function fitSection() {
  if (!map || !props.inspection || props.section == null) return;
  const section = props.inspection.sections[props.section];
  if (!section) return;
  const bounds = new maplibregl.LngLatBounds();
  props.inspection.coordinates.slice(section.fromIndex, section.toIndex + 1).forEach(coord => bounds.extend(coord));
  map.fitBounds(bounds, { padding: 85, maxZoom: 19, duration: 0 });
}

onMounted(() => {
  if (!container.value) return;
  try {
    const theme = getComputedStyle(container.value);
    const color = (name: string) => theme.getPropertyValue(name).trim();
    map = new maplibregl.Map({
      container: container.value,
      center: [15.438, 47.075], zoom: 12,
      maxZoom: 20,
      style: {
        version: 8,
        sources: {
          ...basemapSources,
          streets: { type: 'vector', tiles: [`${location.origin}/tiles/{z}/{x}/{y}.mvt`], minzoom: 9, maxzoom: 16, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> | Local GraphHopper road network' },
          routes: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          comparison: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'surface-sections': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'selected-section': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': color('--map-background') } },
          { id: 'basemap-street', type: 'raster', source: 'basemap-street', layout: { visibility: basemap.value === 'street' ? 'visible' : 'none' }, paint: { 'raster-fade-duration': 0 } },
          { id: 'basemap-aerial', type: 'raster', source: 'basemap-aerial', layout: { visibility: basemap.value === 'aerial' ? 'visible' : 'none' }, paint: { 'raster-fade-duration': 0 } },
          { id: 'basemap-labels', type: 'raster', source: 'basemap-labels', layout: { visibility: basemap.value === 'aerial' ? 'visible' : 'none' }, paint: { 'raster-fade-duration': 0 } },
          { id: 'streets-outline', type: 'line', source: 'streets', 'source-layer': 'roads', layout: { visibility: basemap.value === 'local' ? 'visible' : 'none' }, paint: { 'line-color': color('--map-road-outline'), 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 15, 5] } },
          { id: 'streets', type: 'line', source: 'streets', 'source-layer': 'roads', layout: { visibility: basemap.value === 'local' ? 'visible' : 'none' }, paint: { 'line-color': ['match', ['get', 'road_class'], ['primary', 'secondary', 'tertiary'], '#fffefa', '#ffffff'], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 15, 3] } },
          { id: 'roads-hit', type: 'line', source: 'streets', 'source-layer': 'roads', paint: { 'line-opacity': 0, 'line-width': 16 } },
          { id: 'comparison-lines', type: 'line', source: 'comparison', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['case', ['get', 'shared'], '#64748b', ['match', ['get', 'engine'], 'graphhopper', color('--route-graphhopper'), 'brouter', color('--route-brouter'), color('--route-ors')]], 'line-width': 4 } },
          { id: 'selected-route', type: 'line', source: 'routes', filter: ['==', ['get', 'id'], props.highlighted], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['match', ['get', 'engine'], 'graphhopper', color('--route-graphhopper'), 'brouter', color('--route-brouter'), color('--route-ors')], 'line-width': 6 } },
          { id: 'section-highlight', type: 'line', source: 'selected-section', paint: { 'line-color': '#172033', 'line-width': 14 } },
          { id: 'surface-outline', type: 'line', source: 'surface-sections', paint: { 'line-color': '#fff', 'line-width': 9 } },
          { id: 'surface-lines', type: 'line', source: 'surface-sections', paint: { 'line-color': ['get', 'color'], 'line-width': 5 } },
        ],
      },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.FullscreenControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));
    map.on('load', () => { draw(); fit(); setBasemap(); setRouteOpacity(); });
    map.on('idle', () => { imageryLoading.value = false; });
    map.on('sourcedata', (event) => {
      if (event.sourceId !== 'streets' || event.tile?.state !== 'loaded') return;
      if (failedRoadTiles.delete(tileKey(event)) && !failedRoadTiles.size) {
        roadCheck++;
        roadError.value = '';
      }
    });
    map.on('error', (event) => {
      console.warn('Comparison map error', event);
      const sourceId = 'sourceId' in event ? String(event.sourceId) : '';
      if (sourceId.startsWith('basemap-') || event.error.message.includes('maps.wien.gv.at')) {
        if (basemap.value !== 'local') imageryError.value = 'Online map tiles could not load. Check your connection or select Local roads for the offline view.';
        imageryLoading.value = false;
      } else if (sourceId === 'streets' || event.error.message.includes(`${location.origin}/tiles/`)) {
        const firstFailure = failedRoadTiles.size === 0;
        failedRoadTiles.add(tileKey(event));
        if (firstFailure) void checkRoadService();
      } else {
        mapError.value = 'Part of the map could not display. Retry map to reload it.';
      }
    });
    map.on('click', 'roads-hit', (event) => {
      if (props.showSurfaces && map?.queryRenderedFeatures(event.point, { layers: ['surface-lines'] }).length) return;
      const road = event.features?.[0]?.properties;
      if (!road || !map) return;
      inspectRoad(road, event.lngLat);
    });
    map.on('click', 'surface-lines', event => {
      if (props.showSurfaces && event.features?.[0]) emit('section', Number(event.features[0].properties.index));
    });
    map.on('mouseenter', 'roads-hit', () => { if (map) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'roads-hit', () => { if (map) map.getCanvas().style.cursor = ''; });
    resize = new ResizeObserver(() => { map?.resize(); fit(); });
    resize.observe(container.value);
  } catch (error) {
    mapError.value = error instanceof Error ? error.message : 'The map could not start.';
  }
});

watch(() => [props.routes, props.points], draw);
watch(() => props.points, fit);
watch(() => props.highlighted, id => {
  if (map?.getLayer('selected-route')) map.setFilter('selected-route', ['==', ['get', 'id'], id]);
});
watch(() => props.routes.map(route => route.id).join('|'), () => { differenceIndex.value = -1; });
watch(() => [props.inspection, props.showSurfaces, props.section], drawInspection);
watch(() => props.cursor, drawCursor);
watch(() => props.section, fitSection);
watch(basemap, () => {
  imageryError.value = '';
  imageryLoading.value = basemap.value !== 'local';
  setBasemap();
  try { localStorage.setItem('richiroute.review-basemap', basemap.value); } catch { /* Map controls still work without persistent storage. */ }
});
watch(routeOpacity, setRouteOpacity);
onBeforeUnmount(() => { roadCheck++; resize?.disconnect(); positionMarker?.remove(); markers.forEach((marker) => marker.remove()); map?.remove(); });
</script>

<template>
  <section class="map-shell" aria-label="Route comparison map">
    <div ref="container" class="map-canvas" />
    <div class="map-tools">
      <div class="basemap-controls" role="group" aria-label="Background map">
        <button v-for="option in basemapOptions" :key="option.id" :aria-pressed="basemap === option.id" @click="basemap = option.id">{{ option.label }}</button>
      </div>
      <div class="map-tools-row">
        <button class="map-fit" @click="fit">Fit routes</button>
        <button v-if="!showSurfaces && routeCount > 1" class="next-difference" :disabled="!comparison.differences.length" @click="nextDifference">Next difference<span v-if="comparison.differences.length"> {{ differenceIndex < 0 ? `· ${comparison.differences.length}` : `${differenceIndex + 1}/${comparison.differences.length}` }}</span></button>
        <label class="route-opacity">Route opacity<input v-model.number="routeOpacity" type="range" min="0" max="1" step="0.1" /></label>
      </div>
      <div v-if="!showSurfaces && routeCount" class="comparison-map-status" role="status">
        <strong v-if="selectedName">{{ selectedName }} highlighted</strong>
        <span v-if="routeCount > 1 && !comparison.differences.length">No distinct areas to compare</span>
        <span v-if="sharedLabels.length">Shared sections: {{ sharedLabels.join('; ') }}</span>
      </div>
    </div>
    <div v-if="mapError || imageryError || roadError" class="map-error" role="status">
      {{ imageryError || roadError || mapError }}
      <button @click="retryMap">Retry map</button>
    </div>
    <p v-else-if="imageryLoading" class="map-loading" role="status">Loading map detail…</p>
    <div class="map-caption">{{ basemap === 'local' ? 'Offline road network' : basemap === 'aerial' ? 'Aerial photography + street labels · Free online map' : 'Street names, buildings and terrain · Free online map' }}. Click a road for routing details.</div>
  </section>
</template>

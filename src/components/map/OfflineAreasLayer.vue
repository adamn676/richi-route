<template><div aria-hidden="true" /></template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue';
import type { Map, MapLayerMouseEvent } from 'maplibre-gl';
import { MAP_LABELS_ANCHOR } from '@/config/map.config';
import { routeStyle } from '@/config/mapStyle';
import { useOfflineAreasStore } from '@/stores/offline-areas.store';

// The offline areas over the map: on the device in the paved route's green, grey while loading, a light veil over the
// others; the chosen one ringed in ink. Under the map's water, which covers the sea a country's border reaches into; one
// name each, at the point the outlines file gives.
const props = defineProps<{ map: Map }>();
const offline = useOfflineAreasStore();
const source = 'offline-areas', labels = 'offline-area-labels';
const layers = ['offline-areas-fill', 'offline-areas-line', 'offline-areas-chosen', 'offline-areas-label'];
const ink = '#121816';
let ready = false;

function add() {
  if (!ready || !offline.outlines || props.map.getSource(source)) return;
  props.map.addSource(source, { type: 'geojson', data: offline.outlines, promoteId: 'id' });
  props.map.addSource(labels, { type: 'geojson', data: { type: 'FeatureCollection', features: offline.outlines.features.map(feature => ({
    type: 'Feature', properties: { name: feature.properties.name }, geometry: { type: 'Point', coordinates: feature.properties.label } })) } });
  const below = props.map.getLayer('water') ? 'water' : MAP_LABELS_ANCHOR;
  const state = <T,>(ready: T, loading: T, other: T) =>
    ['match', ['feature-state', 'status'], 'ready', ready, 'loading', loading, other] as never;
  props.map.addLayer({ id: layers[0], type: 'fill', source, paint: {
    'fill-color': state(routeStyle.paved, routeStyle.waiting, '#ffffff'),
    'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], state(.45, .35, .62) as never, state(.35, .25, .5)] as never,
  } }, below);
  props.map.addLayer({ id: layers[1], type: 'line', source, paint: { 'line-color': ink, 'line-opacity': .45, 'line-width': 1 } }, MAP_LABELS_ANCHOR);
  props.map.addLayer({ id: layers[2], type: 'line', source, filter: ['==', ['get', 'id'], ''],
    layout: { 'line-join': 'round' }, paint: { 'line-color': ink, 'line-width': 3 } }, MAP_LABELS_ANCHOR);
  props.map.addLayer({ id: layers[3], type: 'symbol', source: labels, layout: {
    'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-size': 13, 'text-max-width': 8,
  }, paint: { 'text-color': ink, 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
  paint();
}
function paint() {
  if (!props.map.getSource(source)) return;
  for (const area of offline.areas) {
    props.map.setFeatureState({ source, id: area.id }, { status: offline.states[area.id]?.status ?? 'none' });
  }
  props.map.setFilter(layers[2], ['==', ['get', 'id'], offline.selected ?? '']);
}

let hovered: string | null = null;
function hover(id: string | null) {
  if (hovered === id) return;
  if (hovered) props.map.setFeatureState({ source, id: hovered }, { hover: false });
  if (id) props.map.setFeatureState({ source, id }, { hover: true });
  hovered = id;
  props.map.getCanvas().style.cursor = id ? 'pointer' : '';
}
const areaAt = (event: MapLayerMouseEvent) => (event.features?.[0]?.properties.id as string | undefined) ?? null;
function choose(event: MapLayerMouseEvent) {
  const id = areaAt(event);
  offline.selected = offline.selected === id ? null : id;
}
const move = (event: MapLayerMouseEvent) => hover(areaAt(event));
const leave = () => hover(null);

function styleLoaded() { ready = true; add(); }
watch(() => offline.outlines, add);
watch([() => offline.states, () => offline.selected], paint, { deep: true });
onMounted(() => {
  props.map.on('style.load', styleLoaded);
  props.map.on('click', layers[0], choose);
  props.map.on('mousemove', layers[0], move);
  props.map.on('mouseleave', layers[0], leave);
  ready = props.map.isStyleLoaded() === true;
  add();
});
onBeforeUnmount(() => {
  hover(null);
  props.map.off('style.load', styleLoaded);
  props.map.off('click', layers[0], choose);
  props.map.off('mousemove', layers[0], move);
  props.map.off('mouseleave', layers[0], leave);
  for (const layer of [...layers].reverse()) if (props.map.getLayer(layer)) props.map.removeLayer(layer);
  for (const id of [labels, source]) if (props.map.getSource(id)) props.map.removeSource(id);
});
</script>

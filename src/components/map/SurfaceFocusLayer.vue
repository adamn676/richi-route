<template><div aria-hidden="true" /></template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch } from 'vue';
import { LngLatBounds, type Map, type GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection, LineString } from 'geojson';
import type { Coord } from '@/domain/route-model';
import { MAP_LABELS_ANCHOR } from '@/config/map.config';

const props = defineProps<{ map: Map; focus: { coordinates: Coord[] } | null }>();
const source = 'surface-focus-source';
let ready = false;
function update() {
  if (!ready) return;
  const data: FeatureCollection<LineString> = { type: 'FeatureCollection', features: props.focus ? [
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: props.focus.coordinates } },
  ] : [] };
  if (!props.map.getSource(source)) {
    props.map.addSource(source, { type: 'geojson', data });
    props.map.addLayer({ id: 'surface-focus-outline', type: 'line', source,
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 12 } }, MAP_LABELS_ANCHOR);
    props.map.addLayer({ id: 'surface-focus-line', type: 'line', source,
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#19343c', 'line-width': 7, 'line-dasharray': [1, 1] } }, MAP_LABELS_ANCHOR);
  } else {
    (props.map.getSource(source) as GeoJSONSource).setData(data);
  }
}
function styleLoaded() { ready = true; update(); }
watch(() => props.focus, focus => {
  update();
  if (!focus) return;
  const bounds = new LngLatBounds();
  focus.coordinates.forEach(coord => bounds.extend(coord));
  if (!bounds.isEmpty()) props.map.fitBounds(bounds, { padding: 65, maxZoom: 17, duration: 0 });
});
onMounted(() => {
  props.map.on('style.load', styleLoaded);
  ready = props.map.isStyleLoaded() === true;
  update();
});
onBeforeUnmount(() => {
  props.map.off('style.load', styleLoaded);
  for (const layer of ['surface-focus-line', 'surface-focus-outline']) if (props.map.getLayer(layer)) props.map.removeLayer(layer);
  if (props.map.getSource(source)) props.map.removeSource(source);
});
</script>

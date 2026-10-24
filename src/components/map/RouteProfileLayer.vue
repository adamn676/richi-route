<template><div aria-hidden="true" /></template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue';
import type { Map, GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import type { GpxFocus } from '../../domain/gpx-inspection';

const props = defineProps<{ map: Map; focus: GpxFocus | null }>();
const source = 'route-profile-focus';
const layer = 'route-profile-dot';
let ready = false;
function update() {
  if (!ready) return;
  const data: FeatureCollection<Point> = { type: 'FeatureCollection', features: props.focus ? [
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: props.focus.coordinate } },
  ] : [] };
  if (!props.map.getSource(source)) {
    props.map.addSource(source, { type: 'geojson', data });
    props.map.addLayer({ id: layer, type: 'circle', source,
      paint: { 'circle-color': '#19343c', 'circle-radius': 7, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
  } else (props.map.getSource(source) as GeoJSONSource).setData(data);
}
function styleLoaded() { ready = true; update(); }
watch(() => props.focus, update);
onMounted(() => {
  props.map.on('style.load', styleLoaded);
  ready = props.map.isStyleLoaded() === true;
  update();
});
onBeforeUnmount(() => {
  props.map.off('style.load', styleLoaded);
  if (props.map.getLayer(layer)) props.map.removeLayer(layer);
  if (props.map.getSource(source)) props.map.removeSource(source);
});
</script>

<template><div class="gpx-reference-layer" aria-hidden="true" /></template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue';
import type { Map, GeoJSONSource } from 'maplibre-gl';
import type { GpxTrack } from '../../domain/gpx-track';
import { SEGMENTS_OUTLINE_LAYER } from '../../config/map.config';

const props = defineProps<{ map: Map; track: GpxTrack | null; visible: boolean; fitRequest: number }>();
const source = 'gpx-reference';
const layers = ['gpx-reference-outline', 'gpx-reference-line', 'gpx-reference-points'];
let ready = false;
function update() {
  if (!ready) return;
  if (!props.track) {
    for (const id of layers) if (props.map.getLayer(id)) props.map.removeLayer(id);
    if (props.map.getSource(source)) props.map.removeSource(source);
    return;
  }
  if (!props.map.getSource(source)) {
    props.map.addSource(source, { type: 'geojson', data: props.track.geojson });
    const before = props.map.getLayer(SEGMENTS_OUTLINE_LAYER) ? SEGMENTS_OUTLINE_LAYER : undefined;
    props.map.addLayer({ id: layers[0], type: 'line', source,
      filter: ['==', '$type', 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 8 } }, before);
    props.map.addLayer({ id: layers[1], type: 'line', source,
      filter: ['==', '$type', 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#8b46a5', 'line-width': 5, 'line-dasharray': [2, 1] } }, before);
    props.map.addLayer({ id: layers[2], type: 'circle', source,
      filter: ['==', '$type', 'Point'],
      paint: { 'circle-color': '#8b46a5', 'circle-radius': 5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } }, before);
  } else (props.map.getSource(source) as GeoJSONSource).setData(props.track.geojson);
  setVisibility();
}
function setVisibility() {
  for (const id of layers) if (props.map.getLayer(id)) {
    props.map.setLayoutProperty(id, 'visibility', props.visible ? 'visible' : 'none');
  }
}
function fit() {
  if (ready && props.track && props.visible) props.map.fitBounds(props.track.bounds, { padding: 50, maxZoom: 16, duration: 0 });
}
function styleLoaded() { ready = true; update(); fit(); }
watch(() => props.track, () => { update(); fit(); });
watch(() => props.visible, setVisibility);
watch(() => props.fitRequest, fit);
onMounted(() => {
  props.map.on('style.load', styleLoaded);
  ready = props.map.isStyleLoaded() === true;
  update(); fit();
});
onBeforeUnmount(() => {
  props.map.off('style.load', styleLoaded);
  for (const id of layers) if (props.map.getLayer(id)) props.map.removeLayer(id);
  if (props.map.getSource(source)) props.map.removeSource(source);
});
</script>

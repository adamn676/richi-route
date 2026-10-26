<template><div aria-hidden="true" /></template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch } from 'vue';
import { LngLatBounds, type Map, type GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection, LineString } from 'geojson';
import type { Coord, Surface } from '@/domain/route-model';
import { MAP_LABELS_ANCHOR } from '@/config/map.config';
import { routeStyle } from '@/config/mapStyle';

// The chosen section in its surface colour, lifted above the route on a white outline and a soft shadow; the rest of the
// route fades meanwhile, as the other parts of the surface bar do.
const props = defineProps<{ map: Map; focus: { coordinates: Coord[]; surface: Surface } | null }>();
const source = 'surface-focus-source', layers = ['surface-focus-shadow', 'surface-focus-outline', 'surface-focus-line'];
let ready = false;
function update() {
  if (!ready) return;
  const data: FeatureCollection<LineString> = { type: 'FeatureCollection', features: props.focus ? [{ type: 'Feature',
    properties: { color: routeStyle[props.focus.surface] }, geometry: { type: 'LineString', coordinates: props.focus.coordinates } }] : [] };
  if (!props.map.getSource(source)) {
    const layout = { 'line-cap': 'round' as const, 'line-join': 'round' as const };
    props.map.addSource(source, { type: 'geojson', data });
    props.map.addLayer({ id: layers[0], type: 'line', source, layout,
      paint: { 'line-color': '#10231b', 'line-width': 18, 'line-blur': 8, 'line-opacity': .3 } }, MAP_LABELS_ANCHOR);
    props.map.addLayer({ id: layers[1], type: 'line', source, layout, paint: { 'line-color': '#ffffff', 'line-width': 13 } }, MAP_LABELS_ANCHOR);
    props.map.addLayer({ id: layers[2], type: 'line', source, layout, paint: { 'line-color': ['get', 'color'], 'line-width': 8 } }, MAP_LABELS_ANCHOR);
  } else {
    (props.map.getSource(source) as GeoJSONSource).setData(data);
  }
  props.map.setGlobalStateProperty('surfaceFocus', Boolean(props.focus));
}
function styleLoaded() { ready = true; update(); }
watch(() => props.focus, focus => {
  update();
  if (!focus) return;
  const bounds = new LngLatBounds();
  focus.coordinates.forEach(coord => bounds.extend(coord));
  if (!bounds.isEmpty()) props.map.fitBounds(bounds, { padding: 80, maxZoom: 16, duration: 0 });
});
onMounted(() => {
  props.map.on('style.load', styleLoaded);
  ready = props.map.isStyleLoaded() === true;
  update();
});
onBeforeUnmount(() => {
  props.map.off('style.load', styleLoaded);
  props.map.setGlobalStateProperty('surfaceFocus', false);
  for (const layer of [...layers].reverse()) if (props.map.getLayer(layer)) props.map.removeLayer(layer);
  if (props.map.getSource(source)) props.map.removeSource(source);
});
</script>

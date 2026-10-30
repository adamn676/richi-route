<template><div aria-hidden="true" /></template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch } from 'vue';
import type { Map, GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection, LineString, Point } from 'geojson';
import type { Coord, Surface } from '@/domain/route-model';
import { MAP_LABELS_ANCHOR } from '@/config/map.config';
import { routeStyle } from '@/config/mapStyle';

// The chosen section in its surface colour (or a stretch of the profile in its own), lifted above the route on a white
// outline and a soft shadow, with its ends marked; the rest of the route fades meanwhile, as the other parts of the
// surface bar do.
const props = defineProps<{ map: Map; focus: { coordinates: Coord[]; surface?: Surface; color?: string } | null }>();
const source = 'surface-focus-source';
const layers = ['surface-focus-shadow', 'surface-focus-outline', 'surface-focus-line', 'surface-focus-ends'];
let ready = false;
function update() {
  if (!ready) return;
  const focus = props.focus, ends = focus ? [...new Set([focus.coordinates[0], focus.coordinates.at(-1)!])] : [];
  const data: FeatureCollection<LineString | Point> = { type: 'FeatureCollection', features: [
    ...focus && focus.coordinates.length > 1 ? [{ type: 'Feature' as const, properties: { color: focus.color ?? routeStyle[focus.surface!] },
      geometry: { type: 'LineString' as const, coordinates: focus.coordinates } }] : [],
    ...ends.map(coordinates => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates } })),
  ] };
  if (!props.map.getSource(source)) {
    const layout = { 'line-cap': 'round' as const, 'line-join': 'round' as const };
    props.map.addSource(source, { type: 'geojson', data });
    props.map.addLayer({ id: layers[0], type: 'line', source, layout,
      paint: { 'line-color': '#10231b', 'line-width': 18, 'line-blur': 8, 'line-opacity': .3 } }, MAP_LABELS_ANCHOR);
    props.map.addLayer({ id: layers[1], type: 'line', source, layout, paint: { 'line-color': '#ffffff', 'line-width': 13 } }, MAP_LABELS_ANCHOR);
    props.map.addLayer({ id: layers[2], type: 'line', source, layout, paint: { 'line-color': ['get', 'color'], 'line-width': 8 } }, MAP_LABELS_ANCHOR);
    props.map.addLayer({ id: layers[3], type: 'circle', source, filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': '#10231b', 'circle-stroke-width': 2.5 } }, MAP_LABELS_ANCHOR);
  } else {
    (props.map.getSource(source) as GeoJSONSource).setData(data);
  }
  props.map.setGlobalStateProperty('surfaceFocus', Boolean(props.focus));
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
  props.map.setGlobalStateProperty('surfaceFocus', false);
  for (const layer of [...layers].reverse()) if (props.map.getLayer(layer)) props.map.removeLayer(layer);
  if (props.map.getSource(source)) props.map.removeSource(source);
});
</script>

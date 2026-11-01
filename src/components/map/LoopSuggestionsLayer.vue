<template><div aria-hidden="true" /></template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch } from 'vue';
import { type ExpressionSpecification, type Map, type GeoJSONSource, type MapLayerMouseEvent } from 'maplibre-gl';
import type { FeatureCollection, LineString } from 'geojson';
import type { LoopSuggestion } from '@/services/loop-suggestions.service';
import { LOOP_OUTLINE_LAYER, MAP_LABELS_ANCHOR, SEGMENTS_OUTLINE_LAYER } from '@/config/map.config';
import { loopColors } from '@/config/mapStyle';
import { showOnMap } from '@/utils/map-fit';
import { addArrowImage, addArrowLayer, arrowPoints, arrowSpacing, onZoomStep } from '@/utils/route-arrows';

// The suggested loops in their card colours, beneath the route. The selected one is the route itself; the others stay
// faint for comparison, and the one pointed at in the list stands out, with arrows showing its direction.
const props = defineProps<{ map: Map; loops: LoopSuggestion[] | null; highlighted: number | null; selected: number | null }>();
const emit = defineEmits<{ highlight: [index: number | null] }>();
const source = 'loop-suggestions-source', arrows = 'loop-suggestions-arrows';
const layers = [LOOP_OUTLINE_LAYER, 'loop-suggestions-line', arrows];
let ready = false, stopZoom: (() => void) | undefined;
const highlight: ExpressionSpecification = ['coalesce', ['global-state', 'loopHighlight'], -1];
const selection: ExpressionSpecification = ['coalesce', ['global-state', 'loopSelected'], -1];
const isHighlighted: ExpressionSpecification = ['==', ['get', 'index'], highlight];
const notSelected: ExpressionSpecification = ['!=', ['get', 'index'], selection];

function draw() {
  if (!ready) return;
  const data: FeatureCollection<LineString> = { type: 'FeatureCollection', features: (props.loops ?? []).map((loop, index) => (
    { type: 'Feature', properties: { index }, geometry: { type: 'LineString', coordinates: loop.leg.coordinates } })) };
  const existing = props.map.getSource<GeoJSONSource>(source);
  if (existing) { existing.setData(data); mark(); return; }
  const below = props.map.getLayer(SEGMENTS_OUTLINE_LAYER) ? SEGMENTS_OUTLINE_LAYER : MAP_LABELS_ANCHOR;
  props.map.addSource(source, { type: 'geojson', data });
  props.map.addLayer({ id: layers[0], type: 'line', source, filter: notSelected, layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': ['case', isHighlighted, 10, 7] } }, below);
  props.map.addLayer({ id: layers[1], type: 'line', source, filter: notSelected,
    layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['case', isHighlighted, 1, 0] },
    paint: { 'line-color': ['match', ['get', 'index'], 0, loopColors[0], 1, loopColors[1], loopColors[2]],
      'line-width': ['case', isHighlighted, 6, 4],
      'line-opacity': ['case', isHighlighted, 1, ['!=', selection, -1], .45, ['==', highlight, -1], .9, .35] } }, below);
  props.map.addSource(arrows, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  addArrowImage(props.map, 'route-arrow');
  addArrowLayer(props.map, arrows, arrows, 'route-arrow', 1, below);
  mark();
}
// Pointing and selecting change only the map's state, not the loops' data.
function mark() {
  if (!ready) return;
  props.map.setGlobalStateProperty('loopHighlight', props.highlighted ?? -1);
  props.map.setGlobalStateProperty('loopSelected', props.selected ?? -1);
  placeArrows();
}
// Arrows run along the loop pointed at; the selected one is the route, which has its own.
function placeArrows() {
  const index = props.highlighted, loop = index !== null && index !== props.selected ? props.loops?.[index] : undefined;
  const stretches = loop ? [[{ coordinates: loop.leg.coordinates, marked: true }]] : [];
  props.map.getSource<GeoJSONSource>(arrows)?.setData({ type: 'FeatureCollection',
    features: loop ? arrowPoints(stretches, arrowSpacing(props.map.getZoom(), loop.leg.coordinates[0][1])) : [] });
}
function styleLoaded() { ready = true; draw(); }
// Pointing at a loop on the map marks it in the list too; a click chooses it (useMapInteractions).
function point(event: MapLayerMouseEvent) {
  props.map.getCanvas().style.cursor = 'pointer';
  emit('highlight', event.features?.[0]?.properties.index ?? null);
}
function leave() {
  const canvas = props.map.getCanvas();
  if (canvas.style.cursor === 'pointer') canvas.style.cursor = '';
  emit('highlight', null);
}
// The selected loop in view, otherwise all of them.
function fit() {
  const shown = props.selected === null ? props.loops ?? [] : [props.loops![props.selected]];
  showOnMap(props.map, ...shown.map(loop => loop.leg.coordinates));
}
watch(() => props.loops, loops => {
  draw();
  if (loops?.length) fit();
  else leave();
});
watch(() => props.highlighted, mark);
watch(() => props.selected, () => {
  mark();
  if (props.loops?.length) fit();
});
onMounted(() => {
  props.map.on('style.load', styleLoaded);
  props.map.on('mousemove', layers[0], point);
  props.map.on('mouseleave', layers[0], leave);
  ready = props.map.isStyleLoaded() === true;
  draw();
  stopZoom = onZoomStep(props.map, placeArrows);
});
onBeforeUnmount(() => {
  stopZoom?.();
  props.map.off('style.load', styleLoaded);
  props.map.off('mousemove', layers[0], point);
  props.map.off('mouseleave', layers[0], leave);
  for (const layer of [...layers].reverse()) if (props.map.getLayer(layer)) props.map.removeLayer(layer);
  for (const id of [source, arrows]) if (props.map.getSource(id)) props.map.removeSource(id);
});
</script>

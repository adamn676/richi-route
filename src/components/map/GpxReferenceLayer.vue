<template><div class="gpx-reference-layer" aria-hidden="true" /></template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import type { Map, GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import type { GpxTrack } from '../../domain/gpx-track';
import { colorGpxTrack, gpxEndpoints } from '../../domain/gpx-inspection';
import { useGpxReferenceStore } from '../../stores/gpx-reference.store';
import { SEGMENTS_OUTLINE_LAYER } from '../../config/map.config';

const props = defineProps<{ map: Map; track: GpxTrack | null; visible: boolean; fitRequest: number }>();
const reference = useGpxReferenceStore();
const source = 'gpx-reference';
const colorSource = 'gpx-reference-colors';
const endpointSource = 'gpx-reference-endpoints';
const focusSource = 'gpx-reference-focus';
const layers = ['gpx-reference-outline', 'gpx-reference-line', 'gpx-reference-points',
  'gpx-reference-color-line', 'gpx-reference-color-points', 'gpx-reference-arrows',
  'gpx-reference-markers', 'gpx-reference-dot'];
const icons = ['gpx-arrow', 'gpx-start', 'gpx-end', 'gpx-both'];
const empty: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };
const colors = computed(() => props.track && reference.colorMode !== 'plain'
  ? colorGpxTrack(props.track, reference.colorMode, reference.colorMode === 'gradient' ? reference.gradients : []) : empty);
let ready = false;

function addIcons() {
  for (const id of icons) {
    if (props.map.hasImage(id)) continue;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(2, 2);
    if (id === 'gpx-arrow') {
      ctx.beginPath(); ctx.moveTo(12, 10); ctx.lineTo(19, 16); ctx.lineTo(12, 22);
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.strokeStyle = 'white'; ctx.lineWidth = 5; ctx.stroke();
      ctx.strokeStyle = '#19343c'; ctx.lineWidth = 2.5; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(16, 16, 12, 0, Math.PI * 2);
      ctx.fillStyle = id === 'gpx-start' ? '#08796f' : id === 'gpx-end' ? '#a53d39' : '#19343c';
      ctx.fill(); ctx.strokeStyle = 'white'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = 'white'; ctx.font = `bold ${id === 'gpx-both' ? 10 : 13}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(id === 'gpx-start' ? 'S' : id === 'gpx-end' ? 'Z' : 'S/Z', 16, 16.5);
    }
    props.map.addImage(id, ctx.getImageData(0, 0, 64, 64), { pixelRatio: 2 });
  }
}
function removeLayers() {
  for (const id of [...layers].reverse()) if (props.map.getLayer(id)) props.map.removeLayer(id);
  for (const id of [source, colorSource, endpointSource, focusSource]) if (props.map.getSource(id)) props.map.removeSource(id);
  for (const id of icons) if (props.map.hasImage(id)) props.map.removeImage(id);
}
function update() {
  if (!ready) return;
  if (!props.track) { removeLayers(); return; }
  if (!props.map.getSource(source)) {
    addIcons();
    props.map.addSource(source, { type: 'geojson', data: props.track.geojson });
    props.map.addSource(colorSource, { type: 'geojson', data: colors.value });
    props.map.addSource(endpointSource, { type: 'geojson', data: gpxEndpoints(props.track) });
    props.map.addSource(focusSource, { type: 'geojson', data: empty });
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
    props.map.addLayer({ id: layers[3], type: 'line', source: colorSource,
      filter: ['==', '$type', 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 5 } }, before);
    props.map.addLayer({ id: layers[4], type: 'circle', source: colorSource,
      filter: ['==', '$type', 'Point'],
      paint: { 'circle-color': ['get', 'color'], 'circle-radius': 5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } }, before);
    props.map.addLayer({ id: layers[5], type: 'symbol', source,
      filter: ['==', '$type', 'LineString'],
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 100, 'icon-image': 'gpx-arrow',
        'icon-rotation-alignment': 'map', 'icon-keep-upright': false, 'icon-allow-overlap': true } });
    props.map.addLayer({ id: layers[6], type: 'symbol', source: endpointSource,
      layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true } });
    props.map.addLayer({ id: layers[7], type: 'circle', source: focusSource,
      paint: { 'circle-color': '#19343c', 'circle-radius': 7, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
  } else {
    (props.map.getSource(source) as GeoJSONSource).setData(props.track.geojson);
    (props.map.getSource(endpointSource) as GeoJSONSource).setData(gpxEndpoints(props.track));
    updateColors();
  }
  updateFocus();
  setVisibility();
}
function updateColors() {
  (props.map.getSource(colorSource) as GeoJSONSource | undefined)?.setData(colors.value);
  setVisibility();
}
function updateFocus() {
  const focus = reference.focus;
  const data: FeatureCollection<Point> = focus && props.visible ? { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: focus.coordinate } },
  ] } : empty;
  (props.map.getSource(focusSource) as GeoJSONSource | undefined)?.setData(data);
}
function setVisibility() {
  for (const id of layers) if (props.map.getLayer(id)) {
    const plain = id === layers[1] || id === layers[2];
    const colored = id === layers[3] || id === layers[4];
    const visible = props.visible && (!plain || reference.colorMode === 'plain') && (!colored || reference.colorMode !== 'plain');
    props.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}
function fit() {
  if (ready && props.track && props.visible) props.map.fitBounds(props.track.bounds, { padding: 50, maxZoom: 16, duration: 0 });
}
function styleLoaded() { ready = true; update(); fit(); }
watch(() => props.track, () => { update(); fit(); });
watch(() => reference.colorMode, updateColors);
watch(() => reference.focus, updateFocus);
watch(() => props.visible, () => { setVisibility(); updateFocus(); });
watch(() => props.fitRequest, fit);
onMounted(() => {
  props.map.on('style.load', styleLoaded);
  ready = props.map.isStyleLoaded() === true;
  update(); fit();
});
onBeforeUnmount(() => { props.map.off('style.load', styleLoaded); removeLayers(); });
</script>

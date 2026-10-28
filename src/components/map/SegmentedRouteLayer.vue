<template><div class="route-layer" aria-hidden="true" /></template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue';
import type { Map } from 'maplibre-gl';
import type { EditorRoute, RouteFeature } from '@/stores/route.store';
import { useSegmentedRoute } from '@/composables/useSegmentedRoute';

const props = defineProps<{
  map: Map;
  route: EditorRoute | null;
  former: RouteFeature[];
}>();

const { renderSegments, dispose } = useSegmentedRoute();
let ready = false;
function update(): void {
  if (ready) renderSegments(props.map, props.route, props.former);
}
function onStyleLoad(): void {
  ready = true;
  update();
}

watch(() => [props.route, props.former], update);
onMounted(() => {
  props.map.on('style.load', onStyleLoad);
  ready = props.map.isStyleLoaded() === true;
  update();
});
onBeforeUnmount(() => {
  props.map.off('style.load', onStyleLoad);
  dispose();
});
</script>

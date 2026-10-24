<template>
  <ElevationChart :track="track" :color-runs="reference.colorRuns" :focus="reference.focus" :enabled="reference.visible" label="Position im GPX-Track"
    chart-label="Höhenprofil des importierten GPX-Tracks" @inspect="reference.focusAt" />
</template>

<script setup lang="ts">
import type { GpxTrack } from '../../domain/gpx-track';
import { useGpxReferenceStore } from '../../stores/gpx-reference.store';
import ElevationChart from './ElevationChart.vue';

defineProps<{ track: GpxTrack }>();
const reference = useGpxReferenceStore();
</script>

<template>
  <!-- The zoomed stretch's figures, in place of the whole profile's, and the way back to all of it. -->
  <span class="elevation-range" role="group" :aria-label="place">
    <span class="elevation-range__figures" :title="place">{{ formatLength(stats.distance) }} · {{ formatMeters(stats.ascent) }} Anstieg<template
      v-if="stats.gradient !== null"> · Ø {{ formatGradient(stats.gradient) }} %</template><template
      v-if="stats.steepest !== null"> · max {{ formatGradient(stats.steepest) }} %</template></span>
    <v-icon-button size="x-small" aria-label="Ganzes Profil zeigen" v-tooltip:top="'Ganzes Profil zeigen'" @click="emit('reset')">
      <IconZoomOut :size="16" aria-hidden="true" />
    </v-icon-button>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { IconZoomOut } from '@/components/icons';
import { sectionStats } from '../../domain/gpx-inspection';
import type { GpxTrack } from '../../domain/gpx-track';
import { formatGradient, formatKm, formatLength, formatMeters } from '@/utils/format';

const props = defineProps<{ track: GpxTrack; gradients: (number | null)[][]; range: { from: number; to: number } }>();
const emit = defineEmits<{ reset: [] }>();
const stats = computed(() => sectionStats(props.track, props.gradients, props.range.from, props.range.to));
const place = computed(() => `Abschnitt von km ${formatKm(props.range.from, 1)} bis km ${formatKm(props.range.to, 1)}`);
</script>

<style scoped>
.elevation-range { display: inline-flex; align-items: center; gap: .25rem; min-width: 0; margin-right: auto; color: var(--text); }
.elevation-range__figures { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
</style>

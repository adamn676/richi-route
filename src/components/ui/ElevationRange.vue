<template>
  <!-- The zoomed stretch's figures, in place of the whole profile's, and the way back to all of it. -->
  <span class="elevation-range" role="group" :aria-label="place">
    <dl class="stats elevation-range__figures" :title="place">
      <div><dt>Ausschnitt</dt><dd>{{ length[0] }}&nbsp;<small>{{ length[1] }}</small></dd></div>
      <div><dt>Höhenmeter</dt><dd>{{ formatWhole(stats.ascent) }}&nbsp;<small>m</small></dd></div>
      <div v-if="stats.gradient !== null" class="elevation-range__mean"><dt>Ø Steigung</dt><dd>{{ formatGradient(stats.gradient) }}&nbsp;<small>%</small></dd></div>
      <div v-if="stats.steepest !== null"><dt>Max. Steigung</dt><dd>{{ formatGradient(stats.steepest) }}&nbsp;<small>%</small></dd></div>
    </dl>
    <v-icon-button size="x-small" aria-label="Ganzes Profil zeigen" v-tooltip:top="'Ganzes Profil zeigen'" @click="emit('reset')">
      <IconZoomOut :size="18" aria-hidden="true" />
    </v-icon-button>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { IconZoomOut } from '@/components/icons';
import { sectionStats } from '../../domain/gpx-inspection';
import type { GpxTrack } from '../../domain/gpx-track';
import { formatGradient, formatKm, formatWhole } from '@/utils/format';

const props = defineProps<{ track: GpxTrack; gradients: (number | null)[][]; range: { from: number; to: number } }>();
const emit = defineEmits<{ reset: [] }>();
const stats = computed(() => sectionStats(props.track, props.gradients, props.range.from, props.range.to));
const length = computed(() => stats.value.distance < 1000 ? [formatWhole(stats.value.distance), 'm'] : [formatKm(stats.value.distance, 1), 'km']);
const place = computed(() => `Abschnitt von km ${formatKm(props.range.from, 1)} bis km ${formatKm(props.range.to, 1)}`);
</script>

<style scoped>
.elevation-range { display: inline-flex; align-items: center; gap: var(--space-3); min-width: 0; margin-right: auto; }
.elevation-range__figures { flex-wrap: nowrap; min-width: 0; overflow: hidden; }
/* Phones keep the length, climbing and steepest gradient. */
@media (max-width: 760px) { .elevation-range__mean { display: none; } }
</style>

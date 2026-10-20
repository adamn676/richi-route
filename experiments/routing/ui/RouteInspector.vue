<script setup lang="ts">
import { computed } from 'vue';
import { surfaceColor, surfaceLabel, type RouteInspection } from './route-inspection';

const props = defineProps<{
  data: RouteInspection;
  engine: string;
  cursor: number | null;
  section: number | null;
  surfaces: boolean;
}>();
const emit = defineEmits<{
  cursor: [index: number];
  section: [index: number];
  surfaces: [enabled: boolean];
}>();
const total = computed(() => props.data.distances.at(-1) ?? 0);
const heights = computed(() => props.data.elevations.filter((height): height is number => height !== null));
const minimum = computed(() => heights.value.length ? Math.min(...heights.value) : 0);
const maximum = computed(() => heights.value.length ? Math.max(...heights.value) : 0);
const lower = computed(() => Math.floor((minimum.value - 2) / 5) * 5);
const upper = computed(() => Math.max(lower.value + 20, Math.ceil((maximum.value + 2) / 5) * 5));
const x = (metres: number) => (total.value ? metres / total.value : 0) * 700;
const y = (height: number) => 96 - (height - lower.value) / (upper.value - lower.value) * 85;
const profile = computed(() => {
  let connected = false;
  return props.data.elevations.map((height, index) => {
    if (height === null) { connected = false; return ''; }
    const segment = `${connected ? 'L' : 'M'}${x(props.data.distances[index]).toFixed(2)},${y(height).toFixed(2)}`;
    connected = true;
    return segment;
  }).join(' ');
});
const summaries = computed(() => {
  const totals = new Map<string, number>();
  for (const section of props.data.sections) totals.set(section.surface, (totals.get(section.surface) ?? 0) + section.toM - section.fromM);
  return [...totals].sort((a, b) => b[1] - a[1]);
});
const currentIndex = computed(() => props.cursor ?? 0);
const currentDistance = computed(() => props.data.distances[currentIndex.value] ?? 0);
const currentHeight = computed(() => props.data.elevations[currentIndex.value]);
const currentSurface = computed(() => props.data.sections.find(section => currentIndex.value >= section.fromIndex && currentIndex.value < section.toIndex) ?? props.data.sections.at(-1));
const km = (metres: number) => (metres / 1000).toFixed(2);
function scrub(event: PointerEvent) {
  const bounds = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
  const target = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * total.value;
  let nearest = 0;
  props.data.distances.forEach((distance, index) => { if (Math.abs(distance - target) < Math.abs(props.data.distances[nearest] - target)) nearest = index; });
  emit('cursor', nearest);
}
</script>

<template>
  <section class="route-inspector" aria-label="Elevation and surface details">
    <div class="profile-pane">
      <div class="inspector-heading">
        <h2>Elevation <span>{{ engine }}</span></h2>
        <span v-if="heights.length">{{ Math.round(minimum) }} to {{ Math.round(maximum) }} m <template v-if="data.ascentM !== null"> · {{ data.ascentM }} m ascent</template></span>
      </div>
      <div v-if="heights.length" class="chart-frame">
      <div class="chart-y-axis"><span v-for="height in [lower, (upper + lower) / 2, upper]" :key="height" :style="{ top: `${y(height) - 6}px` }">{{ height }} m</span></div>
      <svg class="inspection-chart" viewBox="0 0 700 110" preserveAspectRatio="none" role="img" :aria-label="`${engine} elevation profile with surface strip`" @pointermove="scrub" @pointerdown="scrub">
        <g v-for="height in [lower, (upper + lower) / 2, upper]" :key="height">
          <line x1="0" x2="700" :y1="y(height)" :y2="y(height)" stroke="var(--border)" />
        </g>
        <path :d="profile" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" />
        <rect v-for="(item, index) in data.sections" :key="index" :x="x(item.fromM)" y="101" :width="Math.max(.4, x(item.toM) - x(item.fromM))" height="6" :fill="surfaceColor(item.surface)" />
        <line v-if="cursor !== null" :x1="x(currentDistance)" :x2="x(currentDistance)" y1="10" y2="107" stroke="#172033" stroke-dasharray="3 3" />
      </svg>
      <div class="chart-x-axis"><span>0 km</span><span>{{ km(total / 2) }} km</span><span>{{ km(total) }} km</span></div>
      </div>
      <p v-else class="no-elevation">This saved {{ engine }} route has no elevation data. Select BRouter to inspect its elevation profile.</p>
      <div class="position-readout"><strong>{{ km(currentDistance) }} km</strong><span>{{ currentHeight == null ? 'Elevation unknown' : `${Math.round(currentHeight)} m elevation` }}</span><span>{{ surfaceLabel(currentSurface?.surface ?? 'unknown') }}</span></div>
      <input class="route-position" type="range" min="0" :max="data.coordinates.length - 1" :value="currentIndex" aria-label="Position along selected route" :aria-valuetext="`${km(currentDistance)} kilometres, ${surfaceLabel(currentSurface?.surface ?? 'unknown')}`" @input="emit('cursor', Number(($event.target as HTMLInputElement).value))" />
    </div>
    <div class="surface-pane">
      <div class="inspector-heading"><h2>Road surface</h2><button class="surface-toggle" :aria-pressed="surfaces" @click="emit('surfaces', !surfaces)">{{ surfaces ? 'Show engine colours' : 'Show surface colours' }}</button></div>
      <p class="surface-help">Select a surface to find it on the map.</p>
      <div class="surface-summary">
        <button v-for="[surface, metres] in summaries" :key="surface" :aria-label="`Find ${surfaceLabel(surface)} sections`" @click="emit('section', data.sections.findIndex(item => item.surface === surface))">
          <i :style="{ background: surfaceColor(surface) }" /><span>{{ surfaceLabel(surface) }}</span><strong>{{ total ? (metres / total * 100).toFixed(1) : '0' }}%</strong>
        </button>
      </div>
      <details class="surface-sections">
        <summary>All {{ data.sections.length }} sections by distance</summary>
        <div class="surface-section-list">
          <button v-for="(item, index) in data.sections" :key="index" :aria-pressed="section === index" @click="emit('section', index)">
            <i :style="{ background: surfaceColor(item.surface) }" /><span>{{ surfaceLabel(item.surface) }}</span><span>{{ km(item.fromM) }} to {{ km(item.toM) }} km</span><strong>{{ Math.round(item.toM - item.fromM) }} m</strong>
          </button>
        </div>
      </details>
      <p class="surface-source">{{ data.surfaceSource }}. Unknown means unmapped. Distances follow the saved geometry; surface tags may be incomplete or outdated.</p>
    </div>
  </section>
</template>

<template>
  <div class="elevation-chart">
    <div class="elevation-chart__heading">
      <strong>Höhenprofil</strong>
      <div v-if="colorRuns.length" class="slope-scale" role="img" :aria-label="`Linienfarbe nach Steigung: ${gradientBands.map(band => band.label).join(', ')}`">
        <span>Steigung in %</span>
        <span class="slope-scale__bar"><i v-for="band in gradientBands" :key="band.color" :style="{ backgroundColor: band.color }" /></span>
        <span class="slope-scale__labels" aria-hidden="true">
          <span v-for="(band, i) in gradientBands.slice(0, -1)" :key="band.max" :style="{ left: `${(i + 1) / gradientBands.length * 100}%` }">{{ formatGradient(band.max) }}</span>
        </span>
      </div>
      <slot name="actions" />
    </div>
    <div class="elevation-chart__plot">
      <div class="elevation-chart__altitudes" aria-hidden="true">
        <span v-for="tick in altitudeTicks" :key="tick.value" :style="{ top: `${tick.y / 88 * 100}%` }">{{ formatMeters(tick.value) }}</span>
      </div>
      <div ref="chart" class="elevation-chart__chart" role="slider" :tabindex="enabled ? 0 : -1" :aria-label="label"
        aria-valuemin="0" :aria-valuemax="track.distanceMeters" :aria-valuenow="focus?.distance ?? 0" :aria-valuetext="readout"
        :aria-disabled="!enabled" aria-description="Im Profil bewegen oder berühren. Pfeiltasten wählen die Position, Pos1 und Ende springen an die Endpunkte."
        @pointermove="move" @pointerdown="press" @pointerleave="leave" @pointercancel="selectDistance(null)"
        @keydown="key" @blur="selectDistance(null)">
        <svg viewBox="0 0 300 88" preserveAspectRatio="none" role="img" :aria-label="chartLabel">
          <defs><linearGradient :id="colorId" gradientUnits="userSpaceOnUse" x1="5" x2="295" y1="0" y2="0">
            <template v-for="(run, i) in colorRuns" :key="run.from">
              <stop :offset="run.from" :stop-color="run.color" /><stop :offset="colorRuns[i + 1]?.from ?? 1" :stop-color="run.color" />
            </template>
          </linearGradient><clipPath :id="clipId"><rect width="300" height="78" /></clipPath></defs>
          <path class="elevation-chart__grid" :d="gridPath" fill="none" stroke-dasharray="2 3" vector-effect="non-scaling-stroke" />
          <template v-if="track.profile">
            <g :clip-path="`url(#${clipId})`"><path class="elevation-chart__area" :d="track.profile.areaPath" :fill="paint" :transform="profileTransform" /></g>
            <path class="elevation-chart__line" :d="track.profile.path" :transform="profileTransform" :stroke="paint" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
          </template>
          <line v-if="focus" class="elevation-chart__cursor" :x1="focusX" :x2="focusX" y1="5" y2="84" vector-effect="non-scaling-stroke" />
        </svg>
        <span v-if="focus && focusY !== null" class="elevation-chart__position" :style="{ left: focusLeft, top: `${focusY / 88 * 100}%` }" />
        <!-- Beside the cursor, on whichever side has more room. -->
        <div v-if="focus" class="popover elevation-chart__tooltip" :class="{ 'elevation-chart__tooltip--left': focusX > 150 }"
          :style="{ left: focusLeft }" aria-hidden="true">
          <strong>{{ focus.elevation === null ? 'Höhe unbekannt' : formatMeters(focus.elevation) }}</strong>
          <span>{{ formatKm(focus.distance) }} km</span>
          <span v-if="gradientText">{{ gradientText }} %</span>
        </div>
        <span v-if="!track.profile && !focus" class="elevation-chart__empty">Keine Höhendaten</span>
      </div>
      <div class="elevation-chart__distances" aria-hidden="true">
        <span v-for="tick in distanceTicks" :key="tick.x" :class="{ 'elevation-chart__tick--end': tick.end }" :style="{ left: `${tick.x / 3}%` }">{{ tick.label }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { niceStep, type GpxTrack } from '../../domain/gpx-track';
import { formatKm, formatMeters } from '@/utils/format';
import { gradientBands, unknownGpxColor, type GpxFocus, type GradientRun } from '../../domain/gpx-inspection';

const props = withDefaults(defineProps<{ track: GpxTrack; colorRuns: GradientRun[]; focus: GpxFocus | null; enabled?: boolean; label: string; chartLabel: string }>(), { enabled: true });
const emit = defineEmits<{ inspect: [distance: number | null] }>();
const colorId = `elevation-colors-${useId()}`, clipId = `elevation-clip-${useId()}`;
const paint = computed(() => props.colorRuns.length ? `url(#${colorId})` : unknownGpxColor);
const focus = computed(() => props.focus);
function selectDistance(distance: number | null) { emit('inspect', distance); }
// A position chosen here must not outlive the chart, or its map marker would stay.
onBeforeUnmount(() => selectDistance(null));
// Plot coordinates in viewBox units for a distance along the track and an elevation on its axis.
const xAt = (meters: number) => 5 + (props.track.distanceMeters ? meters / props.track.distanceMeters * 290 : 0);
const yAt = (elevation: number) => {
  const { from, to } = elevationAxis.value!;
  return 78 - (elevation - from) / (to - from) * 68;
};
// The chart's size decides how many axis marks fit.
const chart = ref<HTMLElement>();
const chartSize = ref({ width: 480, height: 136 });
const resize = new ResizeObserver(([entry]) => { chartSize.value = { width: entry.contentRect.width, height: entry.contentRect.height }; });
onMounted(() => resize.observe(chart.value!));
onBeforeUnmount(() => resize.disconnect());
// Distance marks at a round step, about one per 70 px; one at the right edge is right-aligned to stay inside.
const distanceTicks = computed(() => {
  const total = props.track.distanceMeters, { width } = chartSize.value;
  const step = niceStep(Math.max(total / Math.max(2, Math.floor(width / 70)), 10));
  return Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => {
    const x = xAt(i * step);
    return { x, label: `${formatKm(i * step, 3)} km`, end: (300 - x) / 300 * width < 22 };
  });
});
// Elevation axis that starts and ends on a round step: at most five steps, marks at least 11 px apart,
// and of those the one wasting the least height.
const elevationAxis = computed(() => {
  if (!props.track.profile) return null;
  const { minimum, maximum } = props.track.profile, plotHeight = (chartSize.value.height || 136) * 68 / 88;
  let best: { from: number; to: number; step: number } | undefined;
  for (let i = 0, step = niceStep(Math.max(5, (maximum - minimum) / 8)); i < 6 || !best; i++, step = niceStep(step * 1.01)) {
    const from = Math.floor(minimum / step) * step, to = Math.max(Math.ceil(maximum / step) * step, from + step);
    const roomy = plotHeight * step / (to - from) >= Math.min(plotHeight, Math.max(11, plotHeight / 5));
    if (roomy && (!best || to - from < best.to - best.from)) best = { from, to, step };
  }
  return best;
});
const altitudeTicks = computed(() => {
  const axis = elevationAxis.value;
  if (!axis) return [];
  return Array.from({ length: Math.round((axis.to - axis.from) / axis.step) + 1 }, (_, i) => axis.from + i * axis.step)
    .map(value => ({ value, y: yAt(value) }));
});
// The profile is drawn from its lowest (y 78) to its highest point (y 10); this maps it onto the axis.
const profileTransform = computed(() => {
  const profile = props.track.profile;
  if (!profile) return undefined;
  const { from, to } = elevationAxis.value!, scale = Math.max(1, profile.maximum - profile.minimum) / (to - from);
  return `matrix(1 0 0 ${scale} 0 ${yAt(profile.minimum) - 78 * scale})`;
});
const gridPath = computed(() => (altitudeTicks.value.length ? altitudeTicks.value.map(tick => tick.y) : [10, 44, 78])
  .map(y => `M5,${y} H295`).join(' ') + distanceTicks.value.map(tick => ` M${tick.x},10 V78`).join(''));
const focusX = computed(() => xAt(focus.value?.distance ?? 0));
const focusLeft = computed(() => `${focusX.value / 3}%`);
const focusY = computed(() => focus.value?.elevation == null || !props.track.profile ? null : yAt(focus.value.elevation));
const formatGradient = (gradient: number) => gradient.toLocaleString('de-DE', { maximumFractionDigits: 1, signDisplay: 'exceptZero' });
const gradientText = computed(() => focus.value?.gradient == null ? undefined : formatGradient(focus.value.gradient));
const gradientLabel = computed(() => gradientText.value ? `${gradientText.value} % Steigung` : 'Steigung unbekannt');
const readout = computed(() => {
  if (!focus.value) return 'Noch keine Position gewählt';
  const f = focus.value;
  const height = f.elevation === null ? 'Höhe unbekannt' : `${formatMeters(f.elevation)} Höhe`;
  return `${formatKm(f.distance)} km, ${height}, ${gradientLabel.value}, Abschnitt ${f.segmentIndex + 1}`;
});
function move(event: PointerEvent) {
  if (!props.enabled || (event.pointerType === 'touch' && !event.buttons)) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  selectDistance(((event.clientX - rect.left) / rect.width * 300 - 5) / 290 * props.track.distanceMeters);
}
function press(event: PointerEvent) {
  if (!props.enabled) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  move(event);
}
function leave(event: PointerEvent) { if (event.pointerType === 'mouse') selectDistance(null); }
function key(event: KeyboardEvent) {
  if (!props.enabled) return;
  const distance = focus.value?.distance ?? 0, step = props.track.distanceMeters / 1000;
  const positions: Record<string, number | null> = { ArrowRight: distance + step, ArrowLeft: distance - step,
    ArrowUp: distance + step, ArrowDown: distance - step, PageUp: distance + step * 100, PageDown: distance - step * 100,
    Home: 0, End: props.track.distanceMeters, Escape: null };
  if (event.key in positions) { event.preventDefault(); selectDistance(positions[event.key]); }
}
</script>

<style scoped>
.elevation-chart { container-type: inline-size; display: flex; flex-direction: column; font-size: .75rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.elevation-chart__heading { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; min-height: 1.6rem; margin-bottom: .5rem; }
.elevation-chart__heading > strong { margin-right: auto; }
.elevation-chart strong { font-weight: 600; color: var(--text); white-space: nowrap; }
.slope-scale { display: grid; grid-template-columns: auto 6rem; gap: 2px .4rem; align-items: center; font-size: .65rem; }
.slope-scale__bar { display: flex; gap: 1px; height: 6px; }
.slope-scale__bar i { flex: 1; }
.slope-scale__labels { position: relative; grid-column: 2; height: .7rem; font-size: .6rem; line-height: 1; }
.slope-scale__labels span { position: absolute; transform: translateX(-50%); }
@container (max-width: 20rem) { .slope-scale { display: none; } }
/* At most half the chart wide, so it always fits on the side it opens to. */
.elevation-chart__tooltip { position: absolute; top: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 .5rem; width: max-content;
  max-width: calc(50% - .5rem); margin-left: .5rem; padding: .2rem .5rem; border-radius: var(--radius); white-space: nowrap; font-size: .7rem; pointer-events: none; }
.elevation-chart__tooltip--left { margin-left: -.5rem; transform: translateX(-100%); }
.elevation-chart__plot { flex: 1; min-height: 0; display: grid; grid-template-columns: 3rem minmax(0, 1fr); grid-template-rows: var(--elevation-chart-height, 8.5rem) auto; }
.elevation-chart__altitudes { position: relative; grid-column: 1; grid-row: 1; font-size: .65rem; }
.elevation-chart__altitudes span { position: absolute; right: .5rem; transform: translateY(-50%); white-space: nowrap; }
.elevation-chart__chart { grid-column: 2; grid-row: 1; position: relative; touch-action: none; cursor: crosshair; border-radius: var(--radius); }
.elevation-chart__chart[aria-disabled=true] { cursor: default; opacity: .6; }
svg { display: block; width: 100%; height: 100%; overflow: visible; }
.elevation-chart__area { fill-opacity: .16; }
.elevation-chart__grid { stroke: var(--border-input); stroke-opacity: .45; }
.elevation-chart__cursor { stroke: var(--text-muted); }
.elevation-chart__position { position: absolute; width: 10px; height: 10px; border: 2px solid var(--surface); border-radius: 50%; background: var(--text); box-shadow: 0 0 0 1px var(--text); transform: translate(-50%, -50%); pointer-events: none; }
.elevation-chart__distances { position: relative; grid-column: 2; height: 1.15rem; font-size: .65rem; }
.elevation-chart__distances span { position: absolute; top: .25rem; transform: translateX(-50%); white-space: nowrap; }
.elevation-chart__distances .elevation-chart__tick--end { transform: translateX(-100%); }
.elevation-chart__empty { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
</style>

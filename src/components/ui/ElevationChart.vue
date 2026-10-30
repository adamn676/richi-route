<template>
  <div class="elevation-chart">
    <div class="elevation-chart__plot">
      <div class="elevation-chart__altitudes" aria-hidden="true">
        <span v-for="tick in altitudeTicks" :key="tick.value" :style="{ top: `${tick.y / height * 100}%` }">{{ formatMeters(tick.value) }}</span>
      </div>
      <div ref="chart" class="elevation-chart__chart" role="slider" tabindex="0" aria-label="Position in der Route"
        aria-valuemin="0" :aria-valuemax="track.distanceMeters" :aria-valuenow="focus?.distance ?? 0" :aria-valuetext="readout"
        aria-description="Im Profil bewegen oder berühren; über einen Abschnitt ziehen (auf Touch nach langem Drücken) vergrößert ihn, Doppelklick oder Escape zeigt wieder alles. Pfeiltasten wählen die Position, Pos1 und Ende springen an die Endpunkte."
        @pointermove="move" @pointerdown="press" @pointerup="release" @pointerleave="leave" @pointercancel="cancel"
        @click="pin" @dblclick="showAll" @keydown="key" @focusout="leaveFocus">
        <svg :viewBox="`0 0 300 ${height}`" preserveAspectRatio="none" role="img" aria-label="Höhenprofil der Route">
          <defs><linearGradient :id="colorId" gradientUnits="userSpaceOnUse" x1="0" x2="300" y1="0" y2="0">
            <template v-for="(run, i) in runs" :key="run.from">
              <stop :offset="run.from" :stop-color="run.color" /><stop :offset="runs[i + 1]?.from ?? 1" :stop-color="run.color" />
            </template>
          </linearGradient><clipPath :id="clipId"><rect width="300" height="78" /></clipPath>
          <!-- A zoomed profile continues past both sides; it ends at the plot's edges. -->
          <clipPath :id="rangeClipId"><rect width="300" height="78" /></clipPath>
          <clipPath :id="rangeLineClipId"><rect y="-20" width="300" height="120" /></clipPath></defs>
          <path class="elevation-chart__grid" :d="gridPath" fill="none" stroke-dasharray="2 3" vector-effect="non-scaling-stroke" />
          <!-- Zooming, the whole profile moves from the view before to the one chosen, which then shows in its own detail. -->
          <template v-if="zooming && track.profile">
            <g :clip-path="`url(#${rangeClipId})`"><path class="elevation-chart__area elevation-chart__zoom" :d="track.profile.areaPath" :fill="paint" /></g>
            <g :clip-path="`url(#${rangeLineClipId})`"><path class="elevation-chart__line elevation-chart__zoom" :d="track.profile.path"
              :stroke="paint" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" /></g>
          </template>
          <template v-else-if="profile">
            <g :clip-path="`url(#${range ? rangeClipId : clipId})`"><path class="elevation-chart__area" :d="profile.areaPath" :fill="paint" :transform="profileTransform" /></g>
            <g :clip-path="range ? `url(#${rangeLineClipId})` : undefined"><path class="elevation-chart__line" :d="profile.path" :transform="profileTransform"
              :stroke="paint" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" /></g>
          </template>
          <rect v-if="choosing" class="elevation-chart__choice" :x="Math.min(xAt(choosing.start), xAt(choosing.end))" y="10"
            :width="Math.abs(xAt(choosing.end) - xAt(choosing.start))" height="68" />
          <line v-if="shown" class="elevation-chart__cursor" :x1="focusX" :x2="focusX" y1="4" :y2="height" vector-effect="non-scaling-stroke" />
        </svg>
        <span v-if="shown && focusY !== null" class="elevation-chart__position" :style="{ left: focusLeft, top: `${focusY / height * 100}%` }" />
        <!-- Beside the cursor, on whichever side has more room. -->
        <div v-if="shown && focus" class="elevation-chart__tooltip"
          :class="{ 'elevation-chart__tooltip--left': focusX > 150, 'elevation-chart__tooltip--pinned': pinned }"
          :style="{ left: focusLeft }" :aria-hidden="!pinned">
          <strong>{{ focusHeight === null ? 'Höhe unbekannt' : formatMeters(focusHeight) }}</strong>
          <span>{{ formatKm(focus.distance) }} km</span>
          <span v-if="gradientText"><i class="elevation-chart__slope" :style="{ background: gradientColor(focus.gradient!) }" aria-hidden="true" />{{ gradientText }} %</span>
          <a v-if="pinned" class="elevation-chart__street-view" :href="streetViewUrl(focus.coordinate)" target="_blank" rel="noopener noreferrer"
            :aria-label="streetViewLabel" v-tooltip:top="streetViewLabel" :aria-disabled="streetView.missing"
            @click="event => streetView.open(event, focus!.coordinate, focus!.distance)"><IconMan :size="16" aria-hidden="true" /></a>
        </div>
        <span v-if="!profile && !shown" class="elevation-chart__empty">Keine Höhendaten</span>
      </div>
      <div class="elevation-chart__distances" aria-hidden="true">
        <span v-for="tick in distanceTicks" :key="tick.x" :style="{ left: `${tick.x / 3}%` }">{{ tick.label }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { drawProfile, niceStep, profileWindow, smoothedHeight, type GpxTrack } from '../../domain/gpx-track';
import { formatGradient, formatKm, formatMeters } from '@/utils/format';
import { streetViewUrl } from '@/utils/street-view';
import { IconMan } from '@/components/icons';
import { useStreetViewStore } from '@/stores/street-view.store';
import { gradientColor, gradientRuns, unknownGpxColor, type GpxFocus, type GradientRun } from '../../domain/gpx-inspection';

// The distances are the planned route's, so Street View can mark its spot there (even where an out-and-back overlaps itself).
const props = defineProps<{ track: GpxTrack; colorRuns: GradientRun[]; focus: GpxFocus | null }>();
const emit = defineEmits<{ inspect: [distance: number | null] }>();
const streetView = useStreetViewStore();
const colorId = `elevation-colors-${useId()}`, clipId = `elevation-clip-${useId()}`;
const rangeClipId = `elevation-range-clip-${useId()}`, rangeLineClipId = `elevation-range-line-${useId()}`;
// The stretch the chart zooms into, chosen by dragging across it; all of the track otherwise. A new track shows whole.
const range = defineModel<{ from: number; to: number } | null>('range', { default: null });
watch(() => props.track, () => { range.value = null; });
const view = computed(() => range.value ?? { from: 0, to: props.track.distanceMeters });
const profile = computed(() => range.value ? drawProfile(props.track.samples, range.value.from, range.value.to) : props.track.profile);
// Zooming, the whole profile moves, in its own colours.
const runs = computed(() => range.value && !zooming.value ? gradientRuns(props.track, range.value.from, range.value.to) : props.colorRuns);
const paint = computed(() => runs.value.length ? `url(#${colorId})` : unknownGpxColor);
const focus = computed(() => props.focus);
function selectDistance(distance: number | null) { emit('inspect', distance); }
// A position chosen here must not outlive the chart, or its map marker would stay.
onBeforeUnmount(() => selectDistance(null));
// The viewBox: the plot from y 10 to 78, with room above for the line's highest point and little below, so the
// distances sit close under it.
const height = 82;
// Plot coordinates in viewBox units for a distance along the track and an elevation on its axis, and back.
const xAt = (meters: number) => {
  const { from, to } = view.value;
  return to > from ? (meters - from) / (to - from) * 300 : 0;
};
function distanceAt(event: PointerEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(), { from, to } = view.value;
  return Math.min(to, Math.max(from, from + (event.clientX - rect.left) / rect.width * (to - from)));
}
const yAt = (elevation: number, { from, to }: { from: number; to: number } = elevationAxis.value!) => 78 - (elevation - from) / (to - from) * 68;
// The chart's size decides how many axis marks fit.
const chart = ref<HTMLElement>();
const chartSize = ref({ width: 480, height: 136 });
const resize = new ResizeObserver(([entry]) => { chartSize.value = { width: entry.contentRect.width, height: entry.contentRect.height }; });
onMounted(() => resize.observe(chart.value!));
onBeforeUnmount(() => resize.disconnect());
// Distance marks at a round step, about one per 70 px, and the exact distance at the end (at both ends of a zoomed
// stretch), each centred on its grid line; a round mark too close to an exact one gives way.
const distanceTicks = computed(() => {
  const { from, to } = view.value, { width } = chartSize.value;
  const step = niceStep(Math.max((to - from) / Math.max(2, Math.floor(width / 70)), 10)), first = Math.ceil(from / step);
  const apart = (a: number, b: number) => Math.abs(xAt(a) - xAt(b)) / 300 * width >= 52;
  const round = Array.from({ length: Math.max(0, Math.floor(to / step) - first + 1) }, (_, i) => (first + i) * step)
    .filter(meters => apart(meters, to) && (!range.value || apart(meters, from)));
  const exact = (meters: number) => `${formatKm(meters, 1)} km`;
  return [
    ...range.value ? [{ x: xAt(from), label: exact(from) }] : [],
    ...round.map(meters => ({ x: xAt(meters), label: `${formatKm(meters, 3)} km` })),
    { x: xAt(to), label: exact(to) },
  ];
});
// Elevation axis that starts and ends on a round step: at most five steps, marks at least 11 px apart,
// and of those the one wasting the least height.
// A nearly flat stretch keeps some height on the axis, 1 % of its length (50 to 300 m) around its middle, so a few
// metres up and down stay a gentle wave instead of filling the chart.
const elevationAxis = computed(() => {
  if (!profile.value) return null;
  const least = Math.min(300, Math.max(50, (view.value.to - view.value.from) / 100));
  const middle = (profile.value.minimum + profile.value.maximum) / 2;
  const half = Math.max(profile.value.maximum - profile.value.minimum, least) / 2;
  const [minimum, maximum] = [middle - half, middle + half], plotHeight = (chartSize.value.height || 136) * 68 / height;
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
// A profile is drawn from its lowest (y 78) to its highest point (y 10); its height and offset on an axis.
function onAxis(drawn: { minimum: number; maximum: number }, axis: { from: number; to: number }) {
  const scale = Math.max(1, drawn.maximum - drawn.minimum) / (axis.to - axis.from);
  return { scale, y: yAt(drawn.minimum, axis) - 78 * scale };
}
const profileTransform = computed(() => {
  if (!profile.value) return undefined;
  const { scale, y } = onAxis(profile.value, elevationAxis.value!);
  return `matrix(1 0 0 ${scale} 0 ${y})`;
});
// The whole profile placed in a view and on its axis, as a CSS transform.
function placeWhole(shown: { from: number; to: number }, axis: { from: number; to: number }) {
  const width = shown.to - shown.from, { scale, y } = onAxis(props.track.profile!, axis);
  return `matrix(${props.track.distanceMeters / width}, 0, 0, ${scale}, ${-shown.from / width * 300}, ${y})`;
}
// Zooming in and back out both move, as the map does with them; the motion is left out where it is not wanted.
const zooming = ref<object | null>(null);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
watch([view, elevationAxis, () => props.track], async ([shown, axis, track], [before, axisBefore, trackBefore]) => {
  if (shown === before || track !== trackBefore || !axis || !axisBefore || !track.profile || reducedMotion.matches) return;
  const frames = [{ transform: placeWhole(before, axisBefore) }, { transform: placeWhole(shown, axis) }];
  const current = {};
  zooming.value = current;
  await nextTick();
  const moves = [...chart.value?.querySelectorAll('.elevation-chart__zoom') ?? []].map(path => {
    path.getAnimations().forEach(animation => animation.cancel());
    return path.animate(frames, { duration: 400, easing: 'cubic-bezier(.2, 0, 0, 1)', fill: 'forwards' });
  });
  await Promise.all(moves.map(move => move.finished)).catch(() => {});
  if (zooming.value === current) zooming.value = null;
});
const gridPath = computed(() => (altitudeTicks.value.length ? altitudeTicks.value.map(tick => tick.y) : [10, 44, 78])
  .map(y => `M0,${y} H300`).join(' ') + distanceTicks.value.map(tick => ` M${tick.x},10 V78`).join(''));
// A position outside the zoomed stretch (chosen on the map) has no place in the chart.
const shown = computed(() => focus.value !== null && focus.value.distance >= view.value.from && focus.value.distance <= view.value.to);
const focusX = computed(() => xAt(focus.value?.distance ?? 0));
const focusLeft = computed(() => `${focusX.value / 3}%`);
// The height at the position as the line shows it, averaged like the line, so the dot sits on it.
const focusHeight = computed(() => focus.value?.elevation == null ? null
  : smoothedHeight(props.track.samples, focus.value.distance, profileWindow(view.value.to - view.value.from)));
const focusY = computed(() => focusHeight.value === null || !profile.value ? null : yAt(focusHeight.value));
const gradientText = computed(() => focus.value?.gradient == null ? undefined : formatGradient(focus.value.gradient));
const gradientLabel = computed(() => gradientText.value ? `${gradientText.value} % Steigung` : 'Steigung unbekannt');
const readout = computed(() => {
  if (!focus.value) return 'Noch keine Position gewählt';
  const f = focus.value;
  const height = focusHeight.value === null ? 'Höhe unbekannt' : `${formatMeters(focusHeight.value)} Höhe`;
  return `${formatKm(f.distance)} km, ${height}, ${gradientLabel.value}, Abschnitt ${f.segmentIndex + 1}`;
});
// A click or Enter pins the position, so the tooltip stays and links to Street View. Hovering no longer moves it;
// another click or a drag does, and Escape, a route change or leaving the chart releases it.
const pinned = ref(false);
watch(focus, value => { if (!value) pinned.value = false; });
// The Street View icon greys out where Google has no imagery at the pinned position.
watch(() => pinned.value && focus.value ? focus.value.coordinate : null, coord => { streetView.spot = coord; });
const streetViewLabel = computed(() => streetView.missing ? 'Kein Street View hier' : 'Street View');
const fromTooltip = (event: Event) => event.target instanceof Element && event.target.closest('.elevation-chart__tooltip') !== null;
function pin(event: MouseEvent) {
  if (chose) { chose = false; return; }
  if (focus.value && !fromTooltip(event)) pinned.value = true;
}
function leaveFocus(event: FocusEvent) { if (!chart.value?.contains(event.relatedTarget as Node | null)) selectDistance(null); }
// Dragging with a mouse chooses a stretch to zoom into, as does dragging after a long press on touch, where a plain
// drag moves the position.
const choosing = ref<{ start: number; end: number } | null>(null);
let pressed: { x: number; distance: number; touch: boolean } | null = null, longPress: ReturnType<typeof setTimeout> | undefined;
let chose = false;
function move(event: PointerEvent) {
  if (fromTooltip(event)) return;
  const distance = distanceAt(event);
  if (choosing.value) {
    choosing.value = { ...choosing.value, end: distance };
    selectDistance(distance);
    return;
  }
  if (pressed && event.buttons && Math.abs(event.clientX - pressed.x) > (pressed.touch ? 8 : 6)) {
    if (pressed.touch) clearTimeout(longPress);
    else {
      choosing.value = { start: pressed.distance, end: distance };
      return;
    }
  }
  if ((pinned.value || event.pointerType === 'touch') && !event.buttons) return;
  selectDistance(distance);
}
function press(event: PointerEvent) {
  if (fromTooltip(event)) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  chose = false;
  const distance = distanceAt(event);
  pressed = { x: event.clientX, distance, touch: event.pointerType === 'touch' };
  if (pressed.touch) longPress = setTimeout(() => {
    choosing.value = { start: distance, end: distance };
    navigator.vibrate?.(10);
  }, 450);
  move(event);
}
// A stretch of at least 1% of the one shown, and 50 m, becomes the view.
function release() {
  clearTimeout(longPress);
  pressed = null;
  const choice = choosing.value;
  if (!choice) return;
  choosing.value = null;
  chose = true;
  const from = Math.min(choice.start, choice.end), to = Math.max(choice.start, choice.end);
  if (to - from >= Math.max(50, (view.value.to - view.value.from) / 100)) range.value = { from, to };
}
// A double click shows all of the track; its first click pinned no position.
function showAll() {
  range.value = null;
  pinned.value = false;
}
function cancel() {
  clearTimeout(longPress);
  pressed = choosing.value = null;
  selectDistance(null);
}
function leave(event: PointerEvent) { if (event.pointerType === 'mouse' && !pinned.value) selectDistance(null); }
function key(event: KeyboardEvent) {
  if (event.key === 'Enter' && focus.value) { pinned.value = true; return; }
  if (event.key === 'Escape' && range.value) { range.value = null; return; }
  const { from, to } = view.value, distance = focus.value?.distance ?? from, step = (to - from) / 1000;
  const positions: Record<string, number | null> = { ArrowRight: distance + step, ArrowLeft: distance - step,
    ArrowUp: distance + step, ArrowDown: distance - step, PageUp: distance + step * 100, PageDown: distance - step * 100,
    Home: from, End: to, Escape: null };
  if (event.key in positions) {
    event.preventDefault();
    const position = positions[event.key];
    selectDistance(position === null ? null : Math.min(to, Math.max(from, position)));
  }
}
</script>

<style scoped>
.elevation-chart { display: flex; flex-direction: column; font-size: .75rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.elevation-chart strong { font-weight: 600; color: var(--text); white-space: nowrap; }
/* In the tooltips' ink, at most half the chart wide, so it always fits on the side it opens to. The gradient carries
   the dot of its colour on the line. */
.elevation-chart__tooltip { position: absolute; top: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 .5rem; width: max-content;
  max-width: calc(50% - .5rem); margin-left: .5rem; padding: var(--space-1) var(--space-2); border-radius: 6px; background: var(--accent);
  color: rgb(255 255 255 / .78); box-shadow: 0 2px 8px rgb(16 24 22 / .22); white-space: nowrap; font-size: .72rem; pointer-events: none; }
.elevation-chart .elevation-chart__tooltip strong { color: #fff; }
.elevation-chart__slope { display: inline-block; width: 7px; height: 7px; margin-right: var(--space-1); border-radius: 50%; vertical-align: 1px; }
.elevation-chart__tooltip--left { margin-left: -.5rem; transform: translateX(-100%); }
.elevation-chart__tooltip--pinned { pointer-events: auto; }
.elevation-chart__street-view { display: inline-flex; align-self: center; margin: -.15rem; padding: .15rem; border-radius: var(--radius); color: #fff; }
.elevation-chart__street-view:hover:not([aria-disabled=true]) { background: rgb(255 255 255 / .14); }
.elevation-chart__street-view[aria-disabled=true] { opacity: .45; cursor: not-allowed; }
/* The plot takes all the width beside the elevations, leaving on the right half of its last distance, which is centred
   on the last grid line. */
.elevation-chart__plot { flex: 1; min-height: 0; display: grid; grid-template-columns: 3rem minmax(0, 1fr); grid-template-rows: var(--elevation-chart-height, 8.5rem) auto;
  padding-right: 1.25rem; }
.elevation-chart__altitudes { position: relative; grid-column: 1; grid-row: 1; font-size: .65rem; }
.elevation-chart__altitudes span { position: absolute; right: var(--space-2); transform: translateY(-50%); white-space: nowrap; }
.elevation-chart__chart { grid-column: 2; grid-row: 1; position: relative; touch-action: none; cursor: crosshair; border-radius: var(--radius); }
svg { display: block; width: 100%; height: 100%; overflow: visible; }
.elevation-chart__area { fill-opacity: .16; }
.elevation-chart__grid { stroke: var(--border-input); stroke-opacity: .45; }
.elevation-chart__cursor { stroke: var(--text-muted); }
.elevation-chart__choice { fill: var(--accent); fill-opacity: .1; }
.elevation-chart__position { position: absolute; width: 10px; height: 10px; border: 2px solid var(--surface); border-radius: 50%; background: var(--text); box-shadow: 0 0 0 1px var(--text); transform: translate(-50%, -50%); pointer-events: none; }
.elevation-chart__distances { position: relative; grid-column: 2; height: 1rem; font-size: .65rem; }
.elevation-chart__distances span { position: absolute; top: .1rem; transform: translateX(-50%); white-space: nowrap; }
.elevation-chart__empty { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
</style>

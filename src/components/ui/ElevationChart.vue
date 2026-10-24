<template>
  <div class="elevation-chart">
    <div class="elevation-chart__heading">
      <strong>Höhenprofil</strong>
      <span v-if="!focus" class="elevation-chart__unit">Höhe in m</span>
      <div v-else class="elevation-chart__tooltip" aria-hidden="true">
        <span>{{ formatDistance(focus.distance) }} km</span>
        <strong>{{ focus.elevation === null ? '–' : Math.round(focus.elevation) }} m</strong>
        <span :style="{ color: gradientColor }">{{ focus.gradient == null ? '–' : focus.gradient.toLocaleString('de-AT', { maximumFractionDigits: 1, signDisplay: 'exceptZero' }) }} %</span>
      </div>
    </div>
    <div class="elevation-chart__plot">
      <div v-if="track.profile" class="elevation-chart__altitudes" aria-hidden="true">
        <span :style="{ top: track.profile.maximum === track.profile.minimum ? '88.64%' : '11.36%' }">{{ Math.round(track.profile.maximum) }}</span>
        <span v-if="track.profile.maximum - track.profile.minimum >= 2" style="top: 50%">{{ Math.round((track.profile.minimum + track.profile.maximum) / 2) }}</span>
        <span v-if="track.profile.maximum !== track.profile.minimum" style="top: 88.64%">{{ Math.round(track.profile.minimum) }}</span>
      </div>
      <div class="elevation-chart__chart" role="slider" :tabindex="enabled ? 0 : -1" :aria-label="label"
        aria-valuemin="0" :aria-valuemax="track.distanceMeters" :aria-valuenow="focus?.distance ?? 0" :aria-valuetext="readout"
        :aria-disabled="!enabled" aria-description="Im Profil bewegen oder berühren. Pfeiltasten wählen die Position, Pos1 und Ende springen an die Endpunkte."
        @pointermove="move" @pointerdown="press" @pointerleave="leave" @pointercancel="selectDistance(null)"
        @keydown="key" @blur="selectDistance(null)">
        <svg viewBox="0 0 300 88" preserveAspectRatio="none" role="img" :aria-label="chartLabel">
          <defs><linearGradient :id="fillId" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#188c7f" stop-opacity=".28" />
            <stop offset="1" stop-color="#188c7f" stop-opacity=".04" />
          </linearGradient></defs>
          <path d="M5,10 H295 M5,44 H295 M5,78 H295" fill="none" stroke="#e1e9e5" stroke-width="1" vector-effect="non-scaling-stroke" />
          <template v-if="track.profile">
            <path :d="track.profile.areaPath" :fill="`url(#${fillId})`" />
            <path class="elevation-chart__line" :d="track.profile.path" fill="none" stroke="#127b70" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
          </template>
          <line v-if="focus" :x1="focusX" :x2="focusX" y1="5" y2="84" stroke="#405f56" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" />
        </svg>
        <span v-if="focus && focusY !== null" class="elevation-chart__position" :style="{ left: `${focusX / 3}%`, top: `${focusY / 88 * 100}%` }" />
        <span v-if="!track.profile && !focus" class="elevation-chart__empty">Keine Höhendaten</span>
      </div>
      <div class="elevation-chart__distances" aria-hidden="true">
        <span>0</span><span>{{ formatDistance(track.distanceMeters / 2) }}</span><span>{{ formatDistance(track.distanceMeters) }} km</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';
import type { GpxTrack } from '../../domain/gpx-track';
import type { GpxFocus } from '../../domain/gpx-inspection';

const props = withDefaults(defineProps<{ track: GpxTrack; focus: GpxFocus | null; enabled?: boolean; label: string; chartLabel: string }>(), { enabled: true });
const emit = defineEmits<{ inspect: [distance: number | null] }>();
const fillId = `elevation-fill-${useId()}`;
const focus = computed(() => props.focus);
function selectDistance(distance: number | null) { emit('inspect', distance); }
const formatDistance = (meters: number) => (meters / 1000).toLocaleString('de-AT', { maximumFractionDigits: 2 });
const focusX = computed(() => 5 + (props.track.distanceMeters ? (focus.value?.distance ?? 0) / props.track.distanceMeters * 290 : 0));
const focusY = computed(() => focus.value?.elevation == null || !props.track.profile ? null
  : 78 - (focus.value.elevation - props.track.profile.minimum) / Math.max(1, props.track.profile.maximum - props.track.profile.minimum) * 68);
const gradientColor = computed(() => (focus.value?.gradient ?? 0) > 3 ? '#a35d12' : (focus.value?.gradient ?? 0) < -3 ? '#176ca3' : '#127b70');
const gradientLabel = computed(() => focus.value?.gradient == null ? 'Steigung unbekannt'
  : `${focus.value.gradient.toLocaleString('de-AT', { maximumFractionDigits: 1, signDisplay: 'exceptZero' })} % Steigung`);
const readout = computed(() => {
  if (!focus.value) return 'Noch keine Position gewählt';
  const f = focus.value;
  const height = f.elevation === null ? 'Höhe unbekannt' : `${Math.round(f.elevation)} m Höhe`;
  return `${formatDistance(f.distance)} km, ${height}, ${gradientLabel.value}, Abschnitt ${f.segmentIndex + 1}`;
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
.elevation-chart { margin-top: 1rem; font-size: .75rem; color: #64736d; font-variant-numeric: tabular-nums; }
.elevation-chart__heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; min-height: 1.6rem; margin-bottom: .5rem; }
.elevation-chart__heading > strong { font-weight: 650; color: #243b32; white-space: nowrap; }
.elevation-chart__unit { font-size: .68rem; }
.elevation-chart__tooltip { display: flex; align-items: baseline; gap: .6rem; white-space: nowrap; font-size: .7rem; }
.elevation-chart__tooltip strong { font-weight: 650; color: #243b32; }
.elevation-chart__plot { display: grid; grid-template-columns: 2.5rem minmax(0, 1fr); grid-template-rows: 8.5rem auto; }
.elevation-chart__altitudes { position: relative; grid-column: 1; grid-row: 1; font-size: .65rem; }
.elevation-chart__altitudes span { position: absolute; right: .55rem; transform: translateY(-50%); }
.elevation-chart__chart { grid-column: 2; grid-row: 1; position: relative; touch-action: none; cursor: crosshair; border-radius: .25rem; }
.elevation-chart__chart[aria-disabled=true] { cursor: default; opacity: .6; }
svg { display: block; width: 100%; height: 100%; overflow: visible; }
.elevation-chart__position { position: absolute; width: 8px; height: 8px; border: 2px solid white; border-radius: 50%; background: #127b70; box-shadow: 0 0 0 1px #127b70; transform: translate(-50%, -50%); pointer-events: none; }
.elevation-chart__distances { grid-column: 2; display: flex; justify-content: space-between; padding: .25rem 1.67% 0; font-size: .65rem; }
.elevation-chart__empty { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
</style>

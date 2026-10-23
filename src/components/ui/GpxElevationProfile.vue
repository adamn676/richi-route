<template>
  <div class="gpx-profile">
    <div class="gpx-profile__heading">Höhenprofil des Tracks <span v-if="track.profile">{{ Math.round(track.profile.minimum) }}–{{ Math.round(track.profile.maximum) }} m</span></div>
    <svg v-if="track.profile" viewBox="0 0 300 90" preserveAspectRatio="none" role="img" aria-label="Höhenprofil des importierten GPX-Tracks"
      @pointermove="move" @pointerdown="press" @pointerleave="leave" @pointercancel="reference.focusAt(null)">
      <path :d="track.profile.path" fill="none" stroke="#8b46a5" stroke-width="2.5" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      <line v-if="focus" :x1="focusX" :x2="focusX" y1="3" y2="85" stroke="#19343c" stroke-dasharray="2 2" vector-effect="non-scaling-stroke" />
      <circle v-if="focus && focusY !== null" :cx="focusX" :cy="focusY" r="3.5" fill="#19343c" stroke="white" stroke-width="1.5" />
    </svg>
    <p v-else>Dieser Track enthält keine Höhendaten.</p>
    <input type="range" min="0" :max="track.distanceMeters" :step="Math.max(.1, track.distanceMeters / 10000)"
      :value="focus?.distance ?? 0" :disabled="!reference.visible || track.distanceMeters === 0" aria-label="Position im GPX-Track"
      :aria-valuetext="readout" @input="slide" @blur="reference.focusAt(null)" />
    <p class="gpx-profile__readout">{{ focus ? readout : 'Profil berühren oder mit der Maus entlangfahren. Der Regler lässt sich mit den Pfeiltasten bedienen.' }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import type { GpxTrack } from '../../domain/gpx-track';
import { useGpxReferenceStore } from '../../stores/gpx-reference.store';

const props = defineProps<{ track: GpxTrack }>();
const reference = useGpxReferenceStore();
const { focus } = storeToRefs(reference);
const focusX = computed(() => 5 + (props.track.distanceMeters ? (focus.value?.distance ?? 0) / props.track.distanceMeters * 290 : 0));
const focusY = computed(() => focus.value?.elevation == null || !props.track.profile ? null
  : 78 - (focus.value.elevation - props.track.profile.minimum) / Math.max(1, props.track.profile.maximum - props.track.profile.minimum) * 68);
const readout = computed(() => {
  if (!focus.value) return 'Noch keine Position gewählt';
  const f = focus.value;
  const distance = (f.distance / 1000).toLocaleString('de-AT', { maximumFractionDigits: 2 });
  const height = f.elevation === null ? 'Höhe unbekannt' : `${Math.round(f.elevation)} m Höhe`;
  const gradient = f.gradient === null ? 'Steigung unbekannt' : `${f.gradient.toLocaleString('de-AT', { maximumFractionDigits: 1, signDisplay: 'exceptZero' })} % Steigung`;
  return `${distance} km · ${height} · ${gradient} · Abschnitt ${f.segmentIndex + 1}`;
});
function move(event: PointerEvent) {
  if (!reference.visible) return;
  if (event.pointerType === 'touch' && !event.buttons) return;
  const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
  reference.focusAt(((event.clientX - rect.left) / rect.width * 300 - 5) / 290 * props.track.distanceMeters);
}
function press(event: PointerEvent) {
  (event.currentTarget as SVGElement).setPointerCapture(event.pointerId);
  move(event);
}
function leave(event: PointerEvent) { if (event.pointerType === 'mouse') reference.focusAt(null); }
function slide(event: Event) { reference.focusAt(Number((event.target as HTMLInputElement).value)); }
</script>

<style scoped>
.gpx-profile { margin-top: .75rem; font-size: .75rem; color: #60757b; }
.gpx-profile__heading { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .25rem; }
svg { display: block; width: 100%; height: 5rem; margin-top: .4rem; touch-action: none; cursor: crosshair; }
input { display: block; width: 100%; margin: .35rem 0; accent-color: #8b46a5; }
.gpx-profile__readout { margin: .3rem 0; min-height: 2.8em; line-height: 1.4; }
</style>

<template>
  <section class="planner__section loops" aria-labelledby="loops-title">
    <div class="section-heading">
      <h2 id="loops-title" class="text-title-medium">Runde vorschlagen</h2>
      <v-icon-button v-if="loops.suggestions" v-tooltip:bottom="'Zurück zum Start ohne Runde'" aria-label="Vorschläge verwerfen"
        @click="loops.discard()"><IconX :size="18" aria-hidden="true" /></v-icon-button>
    </div>
    <form class="loops__form" @submit.prevent="suggest">
      <!-- Figures as in the profile's header, typed or set with a slider: finer steps where most rides lie. -->
      <div v-for="setting in settings" :key="setting.key" class="loops__setting">
        <label :for="`loops-${setting.key}`" class="loops__label">{{ setting.label }}</label>
        <span class="loops__value"><input :id="`loops-${setting.key}`" class="loops__number field-line" type="number" inputmode="numeric"
          :min="setting.steps[0]" :max="setting.steps.at(-1)" :value="drafts[setting.key] ?? target[setting.key]"
          :style="{ width: `${Math.max(1, String(drafts[setting.key] ?? target[setting.key]).length) + .3}ch` }"
          @input="type(setting, $event)" @change="settle(setting, $event)">&nbsp;<small>{{ setting.unit }}</small></span>
        <input class="loops__range" type="range" min="0" :max="setting.steps.length - 1" step="1" :aria-label="`${setting.label}-Regler`"
          :value="nearest(setting.steps, target[setting.key])" :aria-valuetext="`${formatWhole(target[setting.key])} ${setting.unit}`"
          :style="{ '--filled': `${nearest(setting.steps, target[setting.key]) / (setting.steps.length - 1) * 100}%` }"
          @input="target[setting.key] = setting.steps[+($event.target as HTMLInputElement).value]">
      </div>
      <v-btn type="submit" variant="flat" block :loading="loops.loading" :disabled="!start || loops.loading">Runden vorschlagen</v-btn>
    </form>
    <p v-if="!start" class="text-body-small text-medium-emphasis">Runden beginnen am Start; zuerst einen Start setzen.</p>
    <v-alert v-if="loops.error" type="error">{{ loops.error }}</v-alert>
    <p v-else-if="loops.suggestions && !loops.suggestions.length" class="text-body-small text-medium-emphasis" role="status">Von hier ließ sich keine Runde berechnen.</p>
    <!-- A selected loop is the route below, with its profile and surfaces, and the map zooms to it; the others stay faint.
         Selecting it again shows all three. -->
    <div v-else-if="loops.suggestions" class="loops__cards" role="group" aria-label="Vorschläge">
      <div v-for="(loop, index) in loops.suggestions" :key="index" class="loop-card"
        :class="{ 'loop-card--selected': loops.selected === index, 'loop-card--pointed': loops.highlighted === index }"
        :style="{ '--loop': loopColors[index] }">
        <button type="button" class="loop-card__choice" :aria-pressed="loops.selected === index"
          @mouseenter="loops.highlighted = index" @mouseleave="loops.highlighted = null" @click="loops.toggle(index)">
          <svg class="loop-card__shape" viewBox="0 0 48 48" aria-hidden="true">
            <polyline :points="shapes[index].line" />
            <circle :cx="shapes[index].start[0]" :cy="shapes[index].start[1]" r="3" />
          </svg>
          <span class="loop-card__text">
            <span class="loop-card__name">{{ loop.place ? `Über ${loop.place}` : `Nach ${loop.heading}` }}</span>
            <span class="loop-card__figures">{{ formatKm(loop.leg.distanceMeters, 1, true) }}&nbsp;<small>km</small> · {{ formatWhole(loop.leg.ascentMeters ?? 0) }}&nbsp;<small>m</small></span>
          </span>
        </button>
        <v-btn v-if="loops.selected === index" variant="flat" block @click="loops.keep()">Runde übernehmen</v-btn>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, watch } from 'vue';
import { IconX } from '@/components/icons';
import { useRouteStore } from '@/stores/route.store';
import { useLoopSuggestionsStore } from '@/stores/loop-suggestions.store';
import { loopColors } from '@/config/mapStyle';
import { formatKm, formatWhole } from '@/utils/format';

const route = useRouteStore();
const loops = useLoopSuggestionsStore();
const range = (from: number, to: number, step: number) => Array.from({ length: (to - from) / step + 1 }, (_, i) => from + i * step);
const settings = [
  // Up to the longest brevets; a 1,000 km loop from Graz takes about 30 s and climbs some 10,000 m.
  { key: 'km', label: 'Distanz', unit: 'km', steps: [...range(10, 100, 5), ...range(110, 300, 10), ...range(325, 600, 25), ...range(650, 1000, 50)] },
  { key: 'ascent', label: 'Höhenmeter', unit: 'm',
    steps: [...range(0, 1000, 50), ...range(1100, 3000, 100), ...range(3250, 6000, 250), ...range(6500, 10000, 500), ...range(11000, 15000, 1000)] },
] as const;
type Setting = typeof settings[number];
const nearest = (steps: readonly number[], value: number) =>
  steps.reduce((best, step, i) => Math.abs(step - value) < Math.abs(steps[best] - value) ? i : best, 0);
// A typed figure counts while it lies in the range; leaving the field brings it into the range.
const drafts = reactive<Partial<Record<Setting['key'], string>>>({});
function type(setting: Setting, event: Event) {
  const input = event.target as HTMLInputElement, value = input.valueAsNumber;
  drafts[setting.key] = input.value;
  if (value >= setting.steps[0] && value <= setting.steps.at(-1)!) target[setting.key] = Math.round(value);
}
function settle(setting: Setting, event: Event) {
  const value = (event.target as HTMLInputElement).valueAsNumber;
  if (Number.isFinite(value)) target[setting.key] = Math.min(setting.steps.at(-1)!, Math.max(setting.steps[0], Math.round(value)));
  drafts[setting.key] = undefined;
}
// The last target is kept for the next visit.
const storageKey = 'richiroute.loop-target';
const target = reactive((() => {
  try { return { km: 50, ascent: 500, ...JSON.parse(localStorage.getItem(storageKey) ?? '{}') }; } catch { return { km: 50, ascent: 500 }; }
})());
watch(target, value => { try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* Storage may be disabled. */ } });
// Loops start where the start stop lies on the road, once it has snapped there.
const start = computed(() => {
  const stop = route.waypoints[0];
  return stop?.coord && !stop.snapPending ? stop.coord : null;
});
function suggest() {
  if (start.value) void loops.suggest(start.value, { meters: target.km * 1000, ascent: target.ascent });
}
// Each loop's shape for its card, centred, with north up; all on the scale of the largest, so their sizes compare.
const shapes = computed(() => {
  const all = loops.suggestions ?? [];
  if (!all.length) return [];
  const shrink = Math.cos(all[0].leg.coordinates[0][1] * Math.PI / 180);
  const lines = all.map(loop => {
    const coords = loop.leg.coordinates, every = Math.ceil(coords.length / 150);
    return coords.filter((_, i) => i % every === 0 || i === coords.length - 1).map(([lon, lat]) => [lon * shrink, -lat]);
  });
  const extent = (line: number[][], axis: 0 | 1) => [Math.min(...line.map(p => p[axis])), Math.max(...line.map(p => p[axis]))];
  const size = Math.max(...lines.flatMap(line => [0, 1].map(axis => { const [low, high] = extent(line, axis as 0 | 1); return high - low; }))) || 1;
  return lines.map(line => {
    const [[left, right], [top, bottom]] = [extent(line, 0), extent(line, 1)];
    const place = ([x, y]: number[]) => [24 + (x - (left + right) / 2) / size * 38, 24 + (y - (top + bottom) / 2) / size * 38];
    return { line: line.map(p => place(p).map(n => n.toFixed(1)).join(',')).join(' '), start: place(line[0]) };
  });
});
// Leaving the empty route (a stop set by hand, a route opened) drops a search still running.
onBeforeUnmount(() => { if (!loops.suggestions) loops.clear(); });
</script>

<style scoped>
.loops__form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3) var(--space-6); }
.loops__form > .v-btn { grid-column: 1 / -1; }
.loops__setting { display: grid; gap: 1px; min-width: 0; }
.loops__label { color: var(--text-muted); font-size: .72rem; line-height: 1.2; }
.loops__value { color: var(--text); font-size: 1.25rem; font-weight: 650; line-height: 1.15; letter-spacing: -.01em; font-variant-numeric: tabular-nums; white-space: nowrap; }
.loops__value small { color: var(--text-muted); font-size: .64em; font-weight: 500; letter-spacing: 0; }
/* The figure itself is the field (its line from .field-line), as wide as its digits. */
.loops__number { padding: 0 0 7px; border: 0; border-radius: 0; color: inherit; font: inherit; letter-spacing: inherit; appearance: textfield;
  -moz-appearance: textfield; }
.loops__number::-webkit-inner-spin-button, .loops__number::-webkit-outer-spin-button { margin: 0; appearance: none; }
.loops__number:focus { outline: none; }
/* A slim track, filled in ink up to a handle like the map's markers: ink with a white ring. */
.loops__range { width: 100%; height: 28px; margin: 6px 0 0; background: transparent; cursor: pointer; appearance: none; }
.loops__range::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--accent) var(--filled), var(--border) var(--filled)); }
.loops__range::-moz-range-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--accent) var(--filled), var(--border) var(--filled)); }
.loops__range { --halo: 0 0 0 0 transparent; --grow: 1; }
.loops__range::-webkit-slider-thumb { width: 20px; height: 20px; margin-top: -8px; border: 2px solid #fff; border-radius: 50%; background: var(--accent);
  box-shadow: 0 1px 4px rgb(23 38 42 / .45), var(--halo); transform: scale(var(--grow)); transition: box-shadow .15s, transform .15s; appearance: none; }
.loops__range::-moz-range-thumb { width: 16px; height: 16px; border: 2px solid #fff; border-radius: 50%; background: var(--accent);
  box-shadow: 0 1px 4px rgb(23 38 42 / .45), var(--halo); transform: scale(var(--grow)); transition: box-shadow .15s, transform .15s; }
/* A soft halo where the pointer rests or the keyboard is, a larger one and a slightly bigger handle while dragging. */
.loops__range:hover, .loops__range:focus-visible { --halo: 0 0 0 6px color-mix(in srgb, var(--accent) 10%, transparent); }
.loops__range:active { --halo: 0 0 0 8px color-mix(in srgb, var(--accent) 14%, transparent); --grow: 1.1; }
.loops__range:focus-visible { outline: none; }
.loops__cards { display: grid; gap: var(--space-2); }
/* A card per loop: its shape in its map colour, its name and figures; the chosen one is ringed in that colour and offers
   to keep it. */
.loop-card { display: grid; gap: var(--space-2); padding: var(--space-2); border-radius: var(--radius-lg); box-shadow: inset 0 0 0 1px var(--border);
  transition: background-color .15s, box-shadow .15s; }
.loop-card--pointed { background: var(--accent-soft); }
@media (hover: hover) { .loop-card:hover { background: var(--accent-soft); } }
.loop-card--selected { box-shadow: inset 0 0 0 2px var(--loop); }
.loop-card__choice { display: flex; align-items: center; gap: var(--space-3); width: 100%; padding: 0; border: 0; background: none; color: inherit;
  font: inherit; text-align: left; cursor: pointer; }
.loop-card__choice:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: var(--radius); }
.loop-card__shape { flex: none; width: 56px; height: 56px; border-radius: var(--radius); background: var(--bg); }
.loop-card__shape polyline { fill: none; stroke: var(--loop); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.loop-card__shape circle { fill: var(--accent); stroke: #fff; stroke-width: 1.5; }
.loop-card__text { display: grid; gap: 1px; min-width: 0; }
.loop-card__name { overflow: hidden; color: var(--text); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
/* As the figures in the profile's header: bold numbers, small grey units. */
.loop-card__figures { color: var(--text); font-size: 1.05rem; font-weight: 650; letter-spacing: -.01em; font-variant-numeric: tabular-nums; white-space: nowrap; }
.loop-card__figures small { color: var(--text-muted); font-size: .7em; font-weight: 500; letter-spacing: 0; }
</style>

<template>
  <section class="planner__section loops" aria-labelledby="loops-title">
    <h2 id="loops-title" class="section-title">Runde vorschlagen</h2>
    <form class="loops__form" @submit.prevent="suggest">
      <div class="float"><input id="loop-km" v-model.number="target.km" class="field" type="number" min="10" max="300" step="5" placeholder=" " required>
        <label for="loop-km">Distanz (km)</label></div>
      <div class="float"><input id="loop-ascent" v-model.number="target.ascent" class="field" type="number" min="0" max="6000" step="50" placeholder=" " required>
        <label for="loop-ascent">Anstieg (m)</label></div>
      <button type="submit" class="btn btn--primary" :disabled="!start || loops.loading" :title="start ? undefined : 'Zuerst einen Start setzen'">
        {{ loops.loading ? 'Wird berechnet …' : 'Vorschläge' }}</button>
    </form>
    <p v-if="loops.error" class="notice notice--error" role="alert">{{ loops.error }}</p>
    <p v-else-if="loops.suggestions && !loops.suggestions.length" class="muted" role="status">Von hier ließ sich keine Runde berechnen.</p>
    <template v-else-if="loops.suggestions">
      <!-- A selected loop is the route below, with its profile and surfaces, and the map zooms to it; the others stay faint.
           Selecting it again shows all three. -->
      <ul class="loops__list" aria-label="Vorschläge">
        <li v-for="(loop, index) in loops.suggestions" :key="index">
          <button type="button" class="loops__item" :aria-pressed="loops.selected === index"
            :class="{ 'loops__item--highlighted': loops.highlighted === index }"
            @mouseenter="loops.highlighted = index" @mouseleave="loops.highlighted = null" @click="loops.toggle(index)">
            <i class="loops__swatch" :style="{ background: loopColors[index] }" aria-hidden="true" />
            <span class="loops__text">
              <strong>{{ loop.place ? `Über ${loop.place}` : `Nach ${loop.heading}` }}</strong>
              <span class="muted">{{ loop.place ? `${loop.heading} · ` : '' }}{{ formatKm(loop.leg.distanceMeters, 1, true) }} km · {{ formatMeters(loop.leg.ascentMeters ?? 0) }}</span>
            </span>
          </button>
        </li>
      </ul>
      <div class="loops__actions">
        <button type="button" class="btn btn--primary" :disabled="loops.selected === null" @click="loops.keep()">Übernehmen</button>
        <button type="button" class="btn btn--ghost" title="Zurück zum Start ohne Runde" @click="loops.discard()">Verwerfen</button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, watch } from 'vue';
import { useRouteStore } from '@/stores/route.store';
import { useLoopSuggestionsStore } from '@/stores/loop-suggestions.store';
import { loopColors } from '@/config/mapStyle';
import { formatKm, formatMeters } from '@/utils/format';

const route = useRouteStore();
const loops = useLoopSuggestionsStore();
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
// Leaving the empty route (a stop set by hand, a route opened) drops a search still running.
onBeforeUnmount(() => { if (!loops.suggestions) loops.clear(); });
</script>

<style scoped>
.loops__form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)) auto; align-items: center; gap: .6rem; }
.loops__list { display: grid; gap: .25rem; margin: 0; padding: 0; list-style: none; }
.loops__item { display: flex; align-items: center; gap: .6rem; width: calc(100% + 1rem); margin-inline: -.5rem; padding: .5rem;
  border: 1px solid transparent; border-radius: var(--radius); background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.loops__item--highlighted { background: var(--surface-muted); }
/* Material selected list item: a tonal fill. */
.loops__item[aria-pressed=true] { background: var(--accent-soft); font-weight: 600; }
.loops__item:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.loops__actions { display: flex; gap: .5rem; }
.loops__swatch { flex: none; width: .9rem; height: .9rem; border-radius: 50%; }
.loops__text { display: grid; flex: 1; min-width: 0; font-size: .85rem; }
.loops__text .muted { font-size: .78rem; }
@media (max-width: 380px) { .loops__form { grid-template-columns: repeat(2, minmax(0, 1fr)); } .loops__form .btn { grid-column: 1 / -1; } }
</style>

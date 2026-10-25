<template>
  <section class="planner__section loops" aria-labelledby="loops-title">
    <h2 id="loops-title" class="text-title-medium">Runde vorschlagen</h2>
    <form class="loops__form" @submit.prevent="suggest">
      <v-text-field v-model.number="target.km" label="Distanz" suffix="km" type="number" min="10" max="300" step="5" required />
      <v-text-field v-model.number="target.ascent" label="Anstieg" suffix="m" type="number" min="0" max="6000" step="50" required />
      <span v-tooltip:bottom="{ text: 'Zuerst einen Start setzen', disabled: Boolean(start) }">
        <v-btn type="submit" variant="flat" :loading="loops.loading" :disabled="!start || loops.loading">Vorschläge</v-btn>
      </span>
    </form>
    <v-alert v-if="loops.error" type="error">{{ loops.error }}</v-alert>
    <p v-else-if="loops.suggestions && !loops.suggestions.length" class="text-body-small text-medium-emphasis" role="status">Von hier ließ sich keine Runde berechnen.</p>
    <template v-else-if="loops.suggestions">
      <!-- A selected loop is the route below, with its profile and surfaces, and the map zooms to it; the others stay faint.
           Selecting it again shows all three. -->
      <v-list class="loops__list" role="group" aria-label="Vorschläge">
        <v-list-item v-for="(loop, index) in loops.suggestions" :key="index" tag="button" type="button" role="button" class="loops__item"
          :aria-pressed="loops.selected === index" :active="loops.selected === index" color="primary" rounded="lg"
          :title="loop.place ? `Über ${loop.place}` : `Nach ${loop.heading}`"
          :subtitle="`${loop.place ? `${loop.heading} · ` : ''}${formatKm(loop.leg.distanceMeters, 1, true)} km · ${formatMeters(loop.leg.ascentMeters ?? 0)}`"
          @mouseenter="loops.highlighted = index" @mouseleave="loops.highlighted = null" @click="loops.toggle(index)">
          <template #prepend><span class="loops__swatch" :style="{ background: loopColors[index] }" aria-hidden="true" /></template>
        </v-list-item>
      </v-list>
      <div class="loops__actions">
        <v-btn variant="flat" :disabled="loops.selected === null" @click="loops.keep()">Übernehmen</v-btn>
        <v-btn v-tooltip:bottom="'Zurück zum Start ohne Runde'" variant="text" @click="loops.discard()">Verwerfen</v-btn>
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
.loops__list { padding: 0; }
.loops__item { width: 100%; text-align: left; }
.loops__swatch { display: block; width: .9rem; height: .9rem; border-radius: 50%; }
.loops__actions { display: flex; gap: .5rem; }
@media (max-width: 380px) { .loops__form { grid-template-columns: repeat(2, minmax(0, 1fr)); } .loops__form > span { grid-column: 1 / -1; } }
</style>

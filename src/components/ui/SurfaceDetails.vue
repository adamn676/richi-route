<template>
  <section v-if="totals.length" class="surfaces" aria-labelledby="surfaces-title">
    <h3 id="surfaces-title" class="label">Untergrund</h3>
    <div class="surfaces__bar" aria-hidden="true">
      <i v-for="total in totals" :key="total.key" :style="{ flexGrow: total.meters, background: routeStyle[total.surface] }" />
    </div>
    <div class="surfaces__totals" role="group" aria-label="Belag auswählen">
      <button v-for="total in totals" :key="total.key" type="button"
        :aria-pressed="selectedKey === total.key" @click="selectSurface(total.key)">
        <i class="swatch" :style="{ background: routeStyle[total.surface] }" aria-hidden="true" />
        <span>{{ total.label }}</span><strong>{{ lengthLabel(total.meters) }}</strong>
      </button>
    </div>
    <p v-if="hasLegacyDetails">Ältere Abschnitte kennen nur Belagsgruppen; neu berechnete enthalten die genauen Angaben.</p>
    <template v-if="selectedKey">
      <h4>{{ selectedLabel }} · {{ matching.length }} {{ matching.length === 1 ? 'Abschnitt' : 'Abschnitte' }}</h4>
      <ol class="surfaces__sections">
        <li v-for="section in matching.slice(0, visibleCount)" :key="section.id">
          <button type="button" :aria-pressed="isFocused(section)" @click="focus(section)">
            <span>km {{ formatKm(section.fromMeters, 2, true) }} bis {{ formatKm(section.toMeters, 2, true) }}</span>
            <strong>{{ lengthLabel(section.toMeters - section.fromMeters) }}</strong>
          </button>
        </li>
      </ol>
      <button v-if="matching.length > visibleCount" class="btn surfaces__more" type="button" @click="visibleCount += 10">Weitere Abschnitte</button>
      <button v-if="store.focusedSurface" class="btn surfaces__more" type="button" @click="store.surfaceFocus = null">Markierung aufheben</button>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { routeStyle } from '@/config/mapStyle';
import { inspectSurfaces, type SurfaceSection } from '@/domain/route-surfaces';
import { formatKm } from '@/utils/format';
import { useRouteStore } from '@/stores/route.store';

const store = useRouteStore();
const inspection = computed(() => store.routingPending ? null : inspectSurfaces(store.points, store.legs));
const totals = computed(() => inspection.value?.totals ?? []);
const selectedKey = ref<string | null>(null);
const visibleCount = ref(10);
const matching = computed(() => inspection.value?.sections.filter(section => section.key === selectedKey.value) ?? []);
const selectedLabel = computed(() => totals.value.find(total => total.key === selectedKey.value)?.label);
const hasLegacyDetails = computed(() => Object.values(store.legs).some(leg => leg.surfaces.some(span => !['unknown', 'likelyAsphalt'].includes(span.surface) && span.surfaceTag === undefined)));

function lengthLabel(meters: number) {
  return meters < 1000 ? `${meters < 1 ? '< 1' : Math.round(meters)} m` : `${formatKm(meters, 1)} km`;
}
function focus(section: SurfaceSection) {
  store.inspectSurface(section.legId, section.fromIndex, section.toIndex);
}
// Selecting a material again closes its sections and removes the highlight.
function selectSurface(key: string) {
  if (selectedKey.value === key) {
    selectedKey.value = null;
    store.surfaceFocus = null;
    return;
  }
  selectedKey.value = key;
  visibleCount.value = 10;
  const first = matching.value[0];
  if (first) focus(first);
}
function isFocused(section: SurfaceSection) {
  const focused = store.focusedSurface;
  return focused?.legId === section.legId && focused.fromIndex === section.fromIndex && focused.toIndex === section.toIndex;
}
watch(inspection, value => {
  if (!value?.totals.some(total => total.key === selectedKey.value)) selectedKey.value = null;
  visibleCount.value = 10;
});
</script>

<style scoped>
.surfaces { display: grid; gap: .5rem; }
.surfaces .label { margin: 0; }
.surfaces__bar { display: flex; gap: 2px; height: 8px; overflow: hidden; border-radius: 4px; }
.surfaces__bar i { min-width: 2px; }
.surfaces__totals, .surfaces__sections { display: grid; gap: .1rem; margin: 0 -.5rem; padding: 0; list-style: none; }
p { margin: 0; color: var(--text-muted); font-size: .75rem; line-height: 1.45; }
h4 { margin: .4rem 0 0; font-size: .8rem; }
button[aria-pressed] { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: .5rem; width: 100%; min-height: 1.85rem;
  padding: .25rem .5rem; border: 1px solid transparent; border-radius: var(--radius); background: none; text-align: left; font-size: .78rem; }
.surfaces__totals button { grid-template-columns: 1rem 1fr auto; }
button[aria-pressed]:hover { background: var(--surface-muted); }
button[aria-pressed="true"] { background: var(--accent-soft); font-weight: 600; }
strong { font-variant-numeric: tabular-nums; font-weight: 600; }
.surfaces__more { justify-self: start; }
</style>

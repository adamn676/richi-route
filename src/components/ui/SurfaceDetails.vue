<template>
  <section v-if="totals.length" class="surfaces" aria-labelledby="surfaces-title">
    <h3 id="surfaces-title" class="text-label-large text-medium-emphasis">Untergrund</h3>
    <div class="surfaces__bar" aria-hidden="true">
      <i v-for="total in totals" :key="total.key" :style="{ flexGrow: total.meters, background: routeStyle[total.surface] }" />
    </div>
    <v-list class="surfaces__totals" role="group" aria-label="Belag auswählen">
      <v-list-item v-for="total in totals" :key="total.key" tag="button" type="button" role="button" :aria-pressed="selectedKey === total.key"
        :active="selectedKey === total.key" color="primary" rounded="lg" @click="selectSurface(total.key)">
        <template #prepend><i class="swatch" :style="{ background: routeStyle[total.surface] }" aria-hidden="true" /></template>
        <span>{{ total.label }}</span>
        <template #append><strong>{{ lengthLabel(total.meters) }}</strong></template>
      </v-list-item>
    </v-list>
    <p v-if="hasLegacyDetails">Ältere Abschnitte kennen nur Belagsgruppen; neu berechnete enthalten die genauen Angaben.</p>
    <template v-if="selectedKey">
      <h4>{{ selectedLabel }} · {{ matching.length }} {{ matching.length === 1 ? 'Abschnitt' : 'Abschnitte' }}</h4>
      <v-list class="surfaces__sections">
        <v-list-item v-for="section in matching.slice(0, visibleCount)" :key="section.id" tag="button" type="button" role="button"
          :aria-pressed="isFocused(section)" :active="isFocused(section)" color="primary" rounded="lg" @click="focus(section)">
          <span>km {{ formatKm(section.fromMeters, 2, true) }} bis {{ formatKm(section.toMeters, 2, true) }}</span>
          <template #append><strong>{{ lengthLabel(section.toMeters - section.fromMeters) }}</strong></template>
        </v-list-item>
      </v-list>
      <div class="surfaces__more">
        <v-btn v-if="matching.length > visibleCount" variant="outlined" size="small" @click="visibleCount += 10">Weitere Abschnitte</v-btn>
        <v-btn v-if="store.focusedSurface" variant="text" size="small" @click="store.surfaceFocus = null">Markierung aufheben</v-btn>
      </div>
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
.surfaces__bar { display: flex; gap: 2px; height: 8px; overflow: hidden; border-radius: 4px; }
.surfaces__bar i { min-width: 2px; }
.surfaces__totals, .surfaces__sections { margin: 0 -.5rem; padding: 0; font-size: .8rem; }
p { margin: 0; color: var(--text-muted); font-size: .75rem; line-height: 1.45; }
h4 { margin: .4rem 0 0; font-size: .8rem; }
.v-list-item { width: 100%; min-height: 2rem; text-align: left; }
strong { font-variant-numeric: tabular-nums; font-weight: 600; }
.surfaces__more { display: flex; gap: .4rem; }
</style>

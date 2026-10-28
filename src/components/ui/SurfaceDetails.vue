<template>
  <section v-if="totals.length" class="surfaces" aria-labelledby="surfaces-title">
    <h3 id="surfaces-title" class="text-label-large text-medium-emphasis">Untergrund</h3>
    <!-- The whole route in one bar; a chosen surface stands out in it. -->
    <div class="surfaces__bar" aria-hidden="true">
      <i v-for="total in totals" :key="total.surface" :class="{ 'surfaces__part--faded': selected && selected !== total.surface }"
        :style="{ flexGrow: total.meters, background: routeStyle[total.surface] }" />
    </div>
    <v-list class="surfaces__totals" role="group" aria-label="Belag auswählen">
      <v-list-item v-for="total in totals" :key="total.surface" tag="button" type="button" role="button" :aria-pressed="selected === total.surface"
        :active="selected === total.surface" color="primary" rounded="lg" @click="selectSurface(total.surface)">
        <template #prepend><i class="surfaces__dot" :style="{ background: routeStyle[total.surface] }" aria-hidden="true" /></template>
        <span>{{ surfaceLabels[total.surface] }}</span>
        <template #append><span class="surfaces__amount"><strong>{{ lengthLabel(total.meters) }}</strong><span>{{ share(total.meters) }}</span></span></template>
      </v-list-item>
    </v-list>
    <template v-if="selected">
      <h4>{{ surfaceLabels[selected] }} · {{ matching.length }} {{ matching.length === 1 ? 'Abschnitt' : 'Abschnitte' }}</h4>
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
import { inspectSurfaces, surfaceLabels, type SurfaceSection } from '@/domain/route-surfaces';
import type { Surface } from '@/domain/route-model';
import { formatKm } from '@/utils/format';
import { useRouteStore } from '@/stores/route.store';

const store = useRouteStore();
const inspection = computed(() => store.routingPending ? null : inspectSurfaces(store.points, store.legs));
const totals = computed(() => inspection.value?.totals ?? []);
const selected = ref<Surface | null>(null);
const visibleCount = ref(10);
const matching = computed(() => inspection.value?.sections.filter(section => section.surface === selected.value) ?? []);

function share(meters: number) {
  const percent = meters / inspection.value!.distanceMeters * 100;
  return percent < 1 ? '< 1 %' : `${Math.round(percent)} %`;
}
function lengthLabel(meters: number) {
  return meters < 1000 ? `${meters < 1 ? '< 1' : Math.round(meters)} m` : `${formatKm(meters, 1)} km`;
}
function focus(section: SurfaceSection) {
  store.inspectSurface(section.legId, section.fromIndex, section.toIndex, section.surface);
}
// Selecting a surface again closes its sections and removes the highlight.
function selectSurface(surface: Surface) {
  if (selected.value === surface) {
    selected.value = null;
    store.surfaceFocus = null;
    return;
  }
  selected.value = surface;
  visibleCount.value = 10;
  const first = matching.value[0];
  if (first) focus(first);
}
function isFocused(section: SurfaceSection) {
  const focused = store.focusedSurface;
  return focused?.legId === section.legId && focused.fromIndex === section.fromIndex && focused.toIndex === section.toIndex;
}
watch(inspection, value => {
  if (!value?.totals.some(total => total.surface === selected.value)) selected.value = null;
  visibleCount.value = 10;
});
</script>

<style scoped>
.surfaces { display: grid; gap: .5rem; }
.surfaces__bar { display: flex; gap: 2px; height: 10px; overflow: hidden; border-radius: 5px; }
.surfaces__bar i { min-width: 3px; transition: opacity .15s; }
.surfaces__bar .surfaces__part--faded { opacity: .25; }
.surfaces__dot { width: .625rem; height: .625rem; border-radius: 50%; }
.surfaces__amount { display: inline-flex; align-items: baseline; gap: .5rem; }
.surfaces__amount span { min-width: 2.5rem; color: var(--text-muted); font-size: .75rem; text-align: right; font-variant-numeric: tabular-nums; }
.surfaces__totals, .surfaces__sections { margin: 0 -.5rem; padding: 0; font-size: .8rem; }
p { margin: 0; color: var(--text-muted); font-size: .75rem; line-height: 1.45; }
h4 { margin: .4rem 0 0; font-size: .8rem; }
.v-list-item { width: 100%; min-height: 2rem; text-align: left; }
strong { font-variant-numeric: tabular-nums; font-weight: 600; }
.surfaces__more { display: flex; gap: .4rem; }
</style>

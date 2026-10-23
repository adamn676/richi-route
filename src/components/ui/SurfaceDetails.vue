<template>
  <section v-if="inspection?.totals.length" class="surfaces" aria-label="Beläge der Route">
    <details>
      <summary>
        <strong>Beläge prüfen</strong>
        <span>{{ overview }}</span>
      </summary>
      <p>Beläge laut Kartendaten. Fehlende Angaben bleiben unbekannt.</p>
      <p v-if="hasLegacyDetails">Für ältere Abschnitte sind nur Belagsgruppen gespeichert. Neue Berechnungen enthalten die genauen Angaben aus den Kartendaten.</p>
      <div class="surfaces__totals" aria-label="Belag auswählen">
        <button v-for="total in inspection.totals" :key="total.key" type="button"
          :aria-pressed="selectedKey === total.key" @click="selectSurface(total.key)">
          <i :style="{ background: routeStyle[total.surface] }" aria-hidden="true" />
          <span>{{ total.label }}</span><strong>{{ lengthLabel(total.meters) }}</strong>
        </button>
      </div>
      <template v-if="selectedKey">
        <h3>{{ selectedLabel }} · {{ matching.length }} {{ matching.length === 1 ? 'Abschnitt' : 'Abschnitte' }}</h3>
        <p>Abschnitt auswählen, um ihn auf der Karte zu zeigen.</p>
        <ol class="surfaces__sections">
          <li v-for="section in matching.slice(0, visibleCount)" :key="section.id">
            <button type="button" :aria-pressed="isFocused(section)" @click="focus(section)">
              <span>km {{ positionLabel(section.fromMeters) }} bis {{ positionLabel(section.toMeters) }}</span>
              <strong>{{ lengthLabel(section.toMeters - section.fromMeters) }}</strong>
            </button>
          </li>
        </ol>
        <button v-if="matching.length > visibleCount" class="surfaces__more" type="button" @click="visibleCount += 10">Weitere Abschnitte</button>
        <button v-if="store.focusedSurface" class="surfaces__more" type="button" @click="store.surfaceFocus = null">Markierung aufheben</button>
      </template>
      <p class="surfaces__note">Längen entlang des eingezeichneten Verlaufs, gerundet.</p>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { routeStyle } from '@/config/mapStyle';
import { inspectSurfaces, type SurfaceSection } from '@/domain/route-surfaces';
import { useRouteStore } from '@/stores/route.store';

const store = useRouteStore();
const inspection = computed(() => store.pendingLegCount || store.pendingSnapCount ? null : inspectSurfaces(store.points, store.legs));
const selectedKey = ref<string | null>(null);
const visibleCount = ref(10);
const matching = computed(() => inspection.value?.sections.filter(section => section.key === selectedKey.value) ?? []);
const selectedLabel = computed(() => inspection.value?.totals.find(total => total.key === selectedKey.value)?.label);
const hasLegacyDetails = computed(() => Object.values(store.legs).some(leg => leg.surfaces.some(span => span.surface !== 'unknown' && span.surfaceTag === undefined)));

function lengthLabel(meters: number) {
  return meters < 1000 ? `${meters < 1 ? '< 1' : Math.round(meters)} m` : `${(meters / 1000).toLocaleString('de-AT', { maximumFractionDigits: 1 })} km`;
}
function positionLabel(meters: number) {
  return (meters / 1000).toLocaleString('de-AT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const overview = computed(() => {
  const totals = inspection.value?.totals ?? [];
  const unpaved = totals.filter(total => total.surface === 'unpaved').reduce((sum, total) => sum + total.meters, 0);
  const unknown = totals.find(total => total.key === 'unknown')?.meters ?? 0;
  return [unpaved ? `${lengthLabel(unpaved)} unbefestigt` : '', unknown ? `${lengthLabel(unknown)} unbekannt` : ''].filter(Boolean).join(' · ') || 'Beläge und Abschnitte anzeigen';
});
function focus(section: SurfaceSection) {
  store.inspectSurface(section.legId, section.fromIndex, section.toIndex);
}
function selectSurface(key: string) {
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
.surfaces { border: 1px solid #dde7e5; border-radius: .7rem; padding: .8rem; background: #fff; }
summary { cursor: pointer; color: #19343c; font-size: .83rem; }
summary > span { display: block; margin-top: .35rem; color: #60757b; font-size: .76rem; line-height: 1.4; }
p { margin: .65rem 0; color: #60757b; font-size: .75rem; line-height: 1.45; }
h3 { margin: 1rem 0 .3rem; font-size: .8rem; }
.surfaces__totals { display: grid; gap: .2rem; }
button { border: 1px solid transparent; border-radius: .35rem; padding: .5rem .35rem; background: transparent; color: #19343c; cursor: pointer; text-align: left; font: inherit; font-size: .76rem; }
.surfaces__totals button { display: grid; grid-template-columns: .7rem 1fr auto; align-items: center; gap: .4rem; }
i { width: .7rem; height: .25rem; border-radius: .1rem; }
button:hover { background: #f3f7f5; }
button[aria-pressed="true"] { border-color: #08796f; background: #e9f5f1; }
button:focus-visible, summary:focus-visible { outline: 2px solid #086c78; outline-offset: 2px; }
.surfaces__sections { list-style: none; margin: 0; padding: 0; display: grid; gap: .2rem; }
.surfaces__sections button { display: flex; justify-content: space-between; gap: .4rem; width: 100%; }
strong { font-variant-numeric: tabular-nums; }
.surfaces__more { margin-top: .5rem; border-color: #cddbd9; margin-right: .3rem; }
.surfaces__note { font-size: .7rem; margin-bottom: 0; }
</style>

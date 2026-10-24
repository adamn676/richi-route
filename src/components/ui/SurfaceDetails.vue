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
          <i class="swatch" :style="{ background: routeStyle[total.surface] }" aria-hidden="true" />
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
        <button v-if="matching.length > visibleCount" class="btn surfaces__more" type="button" @click="visibleCount += 10">Weitere Abschnitte</button>
        <button v-if="store.focusedSurface" class="btn surfaces__more" type="button" @click="store.surfaceFocus = null">Markierung aufheben</button>
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
.surfaces { padding: .7rem .8rem; border: 1px solid var(--border); border-radius: var(--radius-lg); }
summary { cursor: pointer; font-size: .85rem; }
summary > span { display: block; margin-top: .2rem; color: var(--text-muted); font-size: .75rem; line-height: 1.4; }
p { margin: .6rem 0; color: var(--text-muted); font-size: .75rem; line-height: 1.45; }
h3 { margin: .9rem 0 .3rem; font-size: .8rem; }
.surfaces__totals, .surfaces__sections { display: grid; gap: .15rem; margin: 0; padding: 0; list-style: none; }
button[aria-pressed] { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: .5rem; width: 100%; min-height: 2rem;
  padding: .35rem .5rem; border: 1px solid transparent; border-radius: var(--radius); background: none; text-align: left; font-size: .78rem; }
.surfaces__totals button { grid-template-columns: 1rem 1fr auto; }
button[aria-pressed]:hover { background: var(--surface-muted); }
button[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); }
strong { font-variant-numeric: tabular-nums; font-weight: 600; }
.surfaces__more { margin: .5rem .4rem 0 0; }
.surfaces__note { margin-bottom: 0; }
</style>

<template>
  <section v-if="totals.length" class="surfaces" :class="{ 'surfaces--stale': store.routingPending }" :aria-busy="store.routingPending"
    aria-labelledby="surfaces-title">
    <!-- Correcting a surface the map has wrong starts here, where the surfaces are listed; the stretch is chosen on the map. -->
    <div class="section-heading">
      <h3 id="surfaces-title" class="text-title-medium">Untergrund</h3>
      <v-icon-button v-if="store.surfacesReportable" :active="store.surfaceReporting" :aria-pressed="store.surfaceReporting" aria-label="Untergrund korrigieren"
        v-tooltip:bottom="store.surfaceReporting ? 'Korrigieren beenden (Esc)' : 'Untergrund korrigieren'"
        @click="store.setSurfaceReporting(!store.surfaceReporting)"><IconPencil :size="18" aria-hidden="true" /></v-icon-button>
    </div>
    <!-- The whole route in one bar; a chosen surface stands out in it. -->
    <div class="surfaces__bar" aria-hidden="true">
      <i v-for="total in totals" :key="total.surface" :class="{ 'surfaces__part--faded': selected && selected !== total.surface }"
        :style="{ flexGrow: total.meters, background: routeStyle[total.surface] }" />
    </div>
    <v-list class="surfaces__totals" role="group" aria-label="Untergrund auswählen">
      <v-list-item v-for="total in totals" :key="total.surface" tag="button" type="button" role="button" :aria-pressed="selected === total.surface"
        :active="selected === total.surface" color="primary" rounded="lg" @click="selectSurface(total.surface)">
        <template #prepend><i class="surfaces__dot" :style="{ background: routeStyle[total.surface] }" aria-hidden="true" /></template>
        <!-- A long label may break after its slash. -->
        <span class="surfaces__label"><template v-for="(part, i) in surfaceLabels[total.surface].split('/')" :key="i"><template v-if="i">/<wbr></template>{{ part }}</template></span>
        <template #append><span class="surfaces__amount"><strong>{{ amount(total.meters).value }}&nbsp;<small>{{ amount(total.meters).unit }}</small></strong><span>{{ share(total.meters) }}</span></span></template>
      </v-list-item>
    </v-list>
    <template v-if="selected">
      <div class="surfaces__step">
        <h4>{{ surfaceLabels[selected] }} · {{ stepLabel }}</h4>
        <template v-if="matching.length > 1">
          <v-icon-button v-tooltip:bottom="'Voriger Abschnitt'" aria-label="Voriger Abschnitt" @click="step(-1)"><IconChevronLeft :size="18" aria-hidden="true" /></v-icon-button>
          <v-icon-button v-tooltip:bottom="'Nächster Abschnitt'" aria-label="Nächster Abschnitt" @click="step(1)"><IconChevronRight :size="18" aria-hidden="true" /></v-icon-button>
        </template>
      </div>
      <v-list class="surfaces__sections">
        <v-list-item v-for="section in matching.slice(0, visibleCount)" :key="section.id" tag="button" type="button" role="button"
          :aria-pressed="isFocused(section)" :active="isFocused(section)" color="primary" rounded="lg" @click="focus(section)">
          <span>km {{ formatKm(section.fromMeters, 2, true) }} bis {{ formatKm(section.toMeters, 2, true) }}<template v-if="section.corrected"> · korrigiert</template></span>
          <template #append><strong>{{ amount(section.toMeters - section.fromMeters).value }}&nbsp;<small>{{ amount(section.toMeters - section.fromMeters).unit }}</small></strong></template>
        </v-list-item>
      </v-list>
      <div v-if="matching.length > visibleCount" class="surfaces__more">
        <v-btn variant="outlined" @click="visibleCount += 10">Weitere Abschnitte</v-btn>
      </div>
    </template>
  </section>
  <!-- The first calculation of a route: the surfaces' shape until they are known. -->
  <section v-else-if="store.routingPending" class="surfaces" aria-busy="true" aria-labelledby="surfaces-title">
    <div class="section-heading"><h3 id="surfaces-title" class="text-title-medium">Untergrund</h3></div>
    <span class="skeleton surfaces__skeleton-bar" />
    <ul class="surfaces__skeleton-rows" aria-hidden="true">
      <li v-for="width in [52, 70, 40]" :key="width"><span class="skeleton surfaces__skeleton-dot" /><span class="skeleton" :style="{ width: `${width}%` }" />
        <span class="skeleton surfaces__skeleton-amount" /></li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { routeStyle } from '@/config/mapStyle';
import { inspectSurfaces, surfaceLabels, type SurfaceSection } from '@/domain/route-surfaces';
import type { Surface } from '@/domain/route-model';
import { formatKm, formatLength } from '@/utils/format';
import { IconChevronLeft, IconChevronRight, IconPencil } from '@/components/icons';
import { useRouteStore } from '@/stores/route.store';

const store = useRouteStore();
// While the route is being recalculated, the last surfaces stay, faded, so the panel keeps its height.
const inspection = shallowRef<ReturnType<typeof inspectSurfaces>>(null);
watch(() => store.routingPending ? undefined : inspectSurfaces(store.points, store.legs), value => {
  if (value !== undefined) inspection.value = value;
}, { immediate: true });
const totals = computed(() => inspection.value?.totals ?? []);
const selected = ref<Surface | null>(null);
const visibleCount = ref(10);
const matching = computed(() => inspection.value?.sections.filter(section => section.surface === selected.value) ?? []);

// A length as a bold figure with a small unit, as in the profile's header.
function amount(meters: number) {
  const text = formatLength(meters), cut = text.lastIndexOf(' ');
  return { value: text.slice(0, cut), unit: text.slice(cut + 1) };
}
function share(meters: number) {
  const percent = meters / inspection.value!.distanceMeters * 100;
  return percent < 1 ? '< 1 %' : `${Math.round(percent)} %`;
}
// Choosing the highlighted section again removes the highlight, as choosing its surface again closes its sections.
function focus(section: SurfaceSection) {
  if (isFocused(section)) store.surfaceFocus = null;
  else store.inspectSurface(section);
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
const position = computed(() => matching.value.findIndex(isFocused));
const stepLabel = computed(() => position.value >= 0 && matching.value.length > 1 ? `${position.value + 1} von ${matching.value.length}`
  : `${matching.value.length} ${matching.value.length === 1 ? 'Abschnitt' : 'Abschnitte'}`);
// From the last section on to the first and back; the list grows to show the one chosen.
function step(by: number) {
  const count = matching.value.length;
  const next = position.value < 0 ? (by > 0 ? 0 : count - 1) : (position.value + by + count) % count;
  visibleCount.value = Math.max(visibleCount.value, Math.ceil((next + 1) / 10) * 10);
  store.inspectSurface(matching.value[next]);
}
function isFocused(section: SurfaceSection) {
  return store.focusedSurface?.id === section.id;
}
watch(inspection, value => {
  if (!value?.totals.some(total => total.surface === selected.value)) selected.value = null;
  visibleCount.value = 10;
});
</script>

<style scoped>
/* In the stops' columns: the dot where the markers are, the text where the addresses are; 44 px rows whose hover and
   selection reach 8 px past the content. */
.surfaces { display: grid; gap: var(--space-3); transition: opacity .2s; }
.surfaces--stale { opacity: .45; pointer-events: none; }
.surfaces__bar { display: flex; gap: 2px; height: 10px; margin-top: var(--space-1); overflow: hidden; border-radius: 5px; }
.surfaces__bar i { min-width: 3px; transition: opacity .15s; }
.surfaces__bar .surfaces__part--faded { opacity: .25; }
.surfaces__dot { width: .625rem; height: .625rem; border-radius: 50%; }
.surfaces__label { display: block; padding-block: var(--space-2); white-space: normal; line-height: 1.3; }
.surfaces__amount { display: inline-flex; align-items: baseline; gap: .5rem; }
.surfaces__amount span { min-width: 2.6rem; color: var(--text-muted); font-size: .75rem; text-align: right; font-variant-numeric: tabular-nums; }
.surfaces__totals, .surfaces__sections { margin: 0; padding: 0; overflow: visible; font-size: .875rem; }
/* The first row's text 20 px under the bar, as from a stop's line to the next label. */
.surfaces__totals { margin-top: -9px; }
.v-list-item { width: calc(100% + 2 * var(--space-2)); max-width: none; min-height: 44px; margin-inline: calc(-1 * var(--space-2));
  padding: 0 var(--space-2); text-align: left; }
.v-list-item :deep(.v-list-item__overlay) { display: none; }
/* Fine lines between the rows, from the text column on; none next to a highlighted row. */
.v-list-item + .v-list-item { background-image: linear-gradient(var(--border), var(--border)); background-position: right var(--space-2) top;
  background-size: calc(100% - 52px) 1px; background-repeat: no-repeat; }
.v-list-item:hover { background-color: color-mix(in srgb, var(--border) 45%, transparent); }
.v-list-item--active { background-color: color-mix(in srgb, var(--border) 80%, transparent); color: var(--text); font-weight: 600; }
.v-list-item:hover + .v-list-item, .v-list-item--active + .v-list-item { background-image: none; }
.surfaces__totals :deep(.v-list-item__prepend) { display: flex; justify-content: center; width: 24px; margin-inline-end: var(--space-3); }
.surfaces__totals :deep(.v-list-item__prepend > *) { margin: 0; }
.surfaces__totals :deep(.v-list-item__spacer) { display: none; }
.surfaces__sections .v-list-item { padding-left: 44px; }
.surfaces__step { display: flex; align-items: center; gap: var(--space-1); margin: var(--space-3) 0 0 36px; }
/* The buttons reach past the line of text without moving it, so the sections follow 16 px under its baseline. */
.surfaces__step button { margin-block: -10px; }
h4 { flex: 1; margin: 0; color: var(--text-muted); font-size: .75rem; font-weight: 400; }
strong { font-variant-numeric: tabular-nums; font-weight: 600; }
strong small { color: var(--text-muted); font-size: .75rem; font-weight: 500; }
.surfaces__more { margin-left: 28px; }
.surfaces__more .v-btn { padding-inline: var(--space-2); color: var(--text); }
.surfaces__skeleton-bar { height: 10px; margin-top: var(--space-1); border-radius: 5px; }
.surfaces__skeleton-rows { display: grid; margin: 0; padding: 0; list-style: none; }
.surfaces__skeleton-rows li { display: grid; grid-template-columns: 24px minmax(0, 1fr) 4.5rem; align-items: center; column-gap: var(--space-3);
  min-height: 44px; }
.surfaces__skeleton-rows .skeleton { height: .8rem; }
.surfaces__skeleton-rows .surfaces__skeleton-dot { justify-self: center; width: .625rem; height: .625rem; border-radius: 50%; }
.surfaces__skeleton-amount { justify-self: end; width: 100%; }
</style>

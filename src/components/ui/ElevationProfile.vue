<template>
  <!-- Docked under the map at a fixed height; folding snaps, so the map above resizes once. The header stays in place,
       so its button keeps the focus. -->
  <section id="elevation-profile" class="profile" :class="{ 'profile--collapsed': collapsed }" aria-label="Höhenprofil">
    <div class="profile__header">
      <!-- The route's distance and climbing, in view also with the phone sheet folded or the drawer closed; the distance is
           approximate while sections are still straight. A zoomed stretch shows its own figures instead. -->
      <ElevationRange v-if="inspection.track && inspection.range" :track="inspection.track" :gradients="inspection.gradients" :range="inspection.range"
        @reset="inspection.range = null" />
      <dl v-else class="stats profile__figures" aria-live="polite">
        <div><dt>Distanz</dt><dd><small v-if="routeStore.hasAirLines">ca.&nbsp;</small>{{ formatKm(routeStore.distanceMeters, 1, true) }}&nbsp;<small>km</small></dd></div>
        <div><dt>Höhenmeter</dt><dd><template v-if="routeStore.ascentMeters !== null">{{ formatWhole(routeStore.ascentMeters) }}&nbsp;<small>m</small></template>
          <span v-else-if="routeStore.routingPending" class="skeleton profile__figure-skeleton" aria-label="wird berechnet" />
          <small v-else>unbekannt</small></dd></div>
      </dl>
      <SlopeScale v-if="!collapsed && inspection.track && inspection.colorRuns.length" />
      <v-icon-button v-tooltip:top="toggleLabel" :aria-label="toggleLabel" :aria-expanded="!collapsed" aria-controls="elevation-profile"
        @click="collapsed = !collapsed">
        <component :is="collapsed ? IconChevronUp : IconChevronDown" :size="16" aria-hidden="true" />
      </v-icon-button>
    </div>
    <template v-if="!collapsed">
      <ElevationChart v-if="inspection.track" v-model:range="inspection.range" :track="inspection.track" :color-runs="inspection.colorRuns"
        :focus="inspection.focus" @inspect="inspection.focusAt" />
      <div v-else-if="routeStore.route && routeStore.routingPending" class="profile__skeleton" role="status">
        <span class="skeleton" aria-hidden="true" /><span class="sr-only">{{ message }}</span>
      </div>
      <p v-else class="profile__empty text-body-small text-medium-emphasis">{{ message }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconChevronDown, IconChevronUp } from '@/components/icons';
import ElevationChart from './ElevationChart.vue';
import ElevationRange from './ElevationRange.vue';
import SlopeScale from './SlopeScale.vue';
import { formatKm, formatWhole } from '@/utils/format';
import { useRouteProfileStore } from '../../stores/route-profile.store';
import { useRouteStore } from '../../stores/route.store';

const inspection = useRouteProfileStore();
const routeStore = useRouteStore();
const collapsed = ref(false);
// A folded profile leaves no stretch marked on the map.
watch(collapsed, folded => { if (folded) inspection.range = null; });
const toggleLabel = computed(() => collapsed.value ? 'Höhenprofil anzeigen' : 'Höhenprofil ausblenden');
const message = computed(() => !routeStore.route ? 'Plane eine Route, um ihr Höhenprofil zu sehen.'
  : routeStore.routingPending ? 'Höhenprofil wird berechnet …'
    : 'Das Höhenprofil erscheint, sobald alle Abschnitte auf Straßen berechnet sind.');
</script>

<style scoped>
.profile { display: flex; flex-direction: column; height: var(--profile-height, auto); font-size: .8rem; }
.profile--collapsed { height: auto; }
.profile__header { display: flex; align-items: center; gap: var(--space-2); min-height: 2rem; margin-bottom: var(--space-1); }
.profile__figures { margin-right: auto; }
/* The fold arrow's glyph, not its target, ends at the margin. */
.profile__header > .v-btn:last-child { margin-right: -12px; }
.profile__figure-skeleton { display: inline-block; width: 3.5rem; height: 1.1rem; vertical-align: middle; }
/* On phones the figures are smaller and stay on one line, and a zoomed stretch's figures take the scale's place. */
@media (max-width: 760px) {
  .profile__header :deep(.stats) { flex-wrap: nowrap; column-gap: var(--space-4); }
  .profile__header :deep(:is(.stats dd, .slope-scale__scale)) { font-size: 1.05rem; }
  .profile__header:has(.elevation-range) .slope-scale { display: none; }
}
.profile > .elevation-chart { flex: 1; min-height: 0; --elevation-chart-height: minmax(0, 1fr); }
.profile__empty { flex: 1; display: grid; place-items: center; text-align: center; }
.profile__skeleton { flex: 1; display: grid; min-height: 0; padding: .4rem 0 .6rem 2.6rem; }
.profile__skeleton .skeleton { border-radius: var(--radius); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>

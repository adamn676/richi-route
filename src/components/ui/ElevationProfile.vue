<template>
  <!-- Docked under the map at a fixed height; folding snaps, so the map above resizes once. The header stays in place,
       so its button keeps the focus. -->
  <section id="elevation-profile" class="profile" :class="{ 'profile--collapsed': collapsed }" aria-label="Höhenprofil">
    <div class="profile__header">
      <strong>Höhenprofil</strong>
      <!-- Distance and climbing stay in view when the phone sheet is folded or the drawer is closed. -->
      <span class="profile__summary text-medium-emphasis"><template v-if="inspection.track">{{ formatKm(routeStore.distanceMeters, 1, true) }} km<template
        v-if="routeStore.ascentMeters !== null"> · {{ formatMeters(routeStore.ascentMeters) }} Anstieg</template></template></span>
      <SlopeScale v-if="!collapsed && inspection.track && inspection.colorRuns.length" />
      <v-icon-button v-tooltip:top="toggleLabel" :aria-label="toggleLabel" :aria-expanded="!collapsed" aria-controls="elevation-profile"
        @click="collapsed = !collapsed">
        <component :is="collapsed ? IconChevronUp : IconChevronDown" :size="16" aria-hidden="true" />
      </v-icon-button>
    </div>
    <template v-if="!collapsed">
      <ElevationChart v-if="inspection.track" :heading="false" :track="inspection.track" :color-runs="inspection.colorRuns" :focus="inspection.focus"
        on-route label="Position in der Route" chart-label="Höhenprofil der Route" @inspect="inspection.focusAt" />
      <p v-else class="profile__empty text-body-small text-medium-emphasis">{{ message }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { IconChevronDown, IconChevronUp } from '@/components/icons';
import ElevationChart from './ElevationChart.vue';
import SlopeScale from './SlopeScale.vue';
import { formatKm, formatMeters } from '@/utils/format';
import { useRouteProfileStore } from '../../stores/route-profile.store';
import { useRouteStore } from '../../stores/route.store';

const inspection = useRouteProfileStore();
const routeStore = useRouteStore();
const collapsed = ref(false);
const toggleLabel = computed(() => collapsed.value ? 'Höhenprofil anzeigen' : 'Höhenprofil ausblenden');
const message = computed(() => !routeStore.route ? 'Plane eine Route, um ihr Höhenprofil zu sehen.'
  : routeStore.routingPending ? 'Höhenprofil wird berechnet …'
    : 'Das Höhenprofil erscheint, sobald alle Abschnitte auf Straßen berechnet sind.');
</script>

<style scoped>
.profile { display: flex; flex-direction: column; height: var(--profile-height, auto); font-size: .8rem; }
.profile--collapsed { height: auto; }
.profile__header { display: flex; align-items: center; gap: .5rem; min-height: 2rem; }
.profile__header > strong { font-weight: 600; }
.profile__summary { margin-right: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* Phones show distance and climbing in the title's place, so they share one line with the scale. */
@media (max-width: 760px) { .profile__header:has(.profile__summary:not(:empty)) > strong { display: none; } }
.profile > .elevation-chart { flex: 1; min-height: 0; --elevation-chart-height: minmax(0, 1fr); }
.profile__empty { flex: 1; display: grid; place-items: center; text-align: center; }
</style>

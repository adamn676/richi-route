<template>
  <!-- Always present at a fixed height, so the map above only resizes when the profile is hidden or shown. -->
  <section id="elevation-profile" class="profile" :class="{ 'profile--collapsed': collapsed }" aria-label="Höhenprofil">
    <ElevationChart v-if="!collapsed && inspection.track" :track="inspection.track" :color-runs="inspection.colorRuns" :focus="inspection.focus"
      on-route label="Position in der Route" chart-label="Höhenprofil der Route" @inspect="inspection.focusAt">
      <template #actions>
        <button ref="toggleButton" type="button" class="btn btn--ghost btn--icon btn--sm" :aria-label="toggleLabel"
          :title="toggleLabel" aria-expanded="true" aria-controls="elevation-profile" @click="toggle">
          <IconChevronDown :size="16" aria-hidden="true" />
        </button>
      </template>
    </ElevationChart>
    <template v-else>
      <div class="profile__bar">
        <strong>Höhenprofil</strong>
        <button ref="toggleButton" type="button" class="btn btn--ghost btn--icon btn--sm" :aria-label="toggleLabel"
          :title="toggleLabel" :aria-expanded="!collapsed" aria-controls="elevation-profile" @click="toggle">
          <component :is="collapsed ? IconChevronUp : IconChevronDown" :size="16" aria-hidden="true" />
        </button>
      </div>
      <p v-if="!collapsed" class="muted profile__empty">{{ message }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { IconChevronDown, IconChevronUp } from '@/components/icons';
import ElevationChart from './ElevationChart.vue';
import { useRouteProfileStore } from '../../stores/route-profile.store';
import { useRouteStore } from '../../stores/route.store';

const inspection = useRouteProfileStore();
const routeStore = useRouteStore();
const collapsed = ref(false);
const toggleButton = ref<HTMLButtonElement>();
const toggleLabel = computed(() => collapsed.value ? 'Höhenprofil anzeigen' : 'Höhenprofil ausblenden');
const message = computed(() => !routeStore.route ? 'Plane eine Route, um ihr Höhenprofil zu sehen.'
  : routeStore.routingPending ? 'Höhenprofil wird berechnet …'
    : 'Das Höhenprofil erscheint, sobald alle Abschnitte auf Straßen berechnet sind.');

// Switching between the bar and the chart replaces the toggle; keep keyboard focus on the new one.
async function toggle() {
  collapsed.value = !collapsed.value;
  await nextTick();
  toggleButton.value?.focus();
}
</script>

<style scoped>
.profile { display: flex; flex-direction: column; height: var(--profile-height, auto); font-size: .8rem; }
.profile--collapsed { height: auto; }
.profile > .elevation-chart { flex: 1; min-height: 0; --elevation-chart-height: minmax(0, 1fr); }
.profile__bar { display: flex; align-items: center; justify-content: space-between; gap: .75rem; min-height: 2rem; }
.profile__empty { flex: 1; display: grid; place-items: center; text-align: center; }
</style>

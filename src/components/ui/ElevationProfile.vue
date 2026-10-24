<template>
  <section class="profile">
    <ElevationChart v-if="inspection.track" :track="inspection.track" :focus="inspection.focus" label="Position in der Route"
      chart-label="Höhenprofil der Route" @inspect="inspection.focusAt" />
    <template v-else>
      <strong>Höhenprofil</strong>
      <p>Höhendaten erscheinen nach der Routenberechnung.</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import ElevationChart from './ElevationChart.vue';
import { useRouteProfileStore } from '../../stores/route-profile.store';

const inspection = useRouteProfileStore();
onBeforeUnmount(() => inspection.focusAt(null));
</script>

<style scoped>
.profile { font-size: .8rem; }
.profile p { margin: .4rem 0 0; color: var(--text-muted); }
</style>

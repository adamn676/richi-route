<template>
  <section class="surface-report" aria-label="Untergrund korrigieren">
    <!-- A panel as the map's menus: its heading row with the ×, the choices under it. -->
    <div class="section-heading">
      <h2 class="text-title-medium">Untergrund für {{ formatLength(selection.meters) }}</h2>
      <v-icon-button aria-label="Auswahl aufheben" @click="store.surfacePick = null"><IconX :size="18" aria-hidden="true" /></v-icon-button>
    </div>
    <div class="surface-report__choices">
      <!-- The surface it has now shows as chosen. -->
      <v-btn v-for="surface in choices" :key="surface" :variant="current === surface ? 'tonal' : 'outlined'" :disabled="saving"
        :aria-pressed="current === surface" @click="current !== surface && report(surface)">
        <template #prepend><i class="surface-report__dot" :style="{ background: routeStyle[surface] }" aria-hidden="true" /></template>
        {{ surfaceLabels[surface] }}
        <template v-if="current === surface" #append><IconCheck :size="18" aria-hidden="true" /></template>
      </v-btn>
      <v-btn v-if="selection.corrected" variant="text" :disabled="saving" @click="report(null)">
        <template #prepend><IconArrowBackUp :size="18" aria-hidden="true" /></template>
        Laut Karte
      </v-btn>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { routeStyle } from '@/config/mapStyle';
import { surfaceLabels } from '@/domain/route-surfaces';
import type { CorrectedSurface } from '@/domain/surface-corrections';
import { useRouteStore } from '@/stores/route.store';
import { formatLength } from '@/utils/format';
import { IconArrowBackUp, IconCheck, IconX } from '@/components/icons';

// The stretch tapped on the map and what it is in fact: a colour of the route each, or the map's own surface again.
const store = useRouteStore();
const selection = computed(() => store.surfaceSelection!);
const choices: CorrectedSurface[] = ['paved', 'unpaved', 'rough'];
const current = computed(() => selection.value.surfaces.length === 1 ? selection.value.surfaces[0] : null);
const saving = ref(false);

async function report(surface: CorrectedSurface | null) {
  saving.value = true;
  try {
    await store.reportSurface(surface);
  } catch (error) {
    store.errorMessage = error instanceof Error ? error.message : 'Die Korrektur konnte nicht gespeichert werden.';
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.surface-report { display: grid; gap: var(--space-3); width: min(22rem, 100%); padding: var(--space-3) var(--gutter) var(--space-6);
  background: var(--surface); box-shadow: var(--shadow-menu) !important; }
.surface-report__choices { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.surface-report__dot { width: .625rem; height: .625rem; border-radius: 50%; }
</style>

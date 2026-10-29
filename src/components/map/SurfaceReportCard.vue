<template>
  <section class="surface-report" aria-label="Untergrund korrigieren">
    <header>
      <strong>{{ formatLength(selection.meters) }}</strong>
      <v-icon-button variant="text" size="x-small" aria-label="Auswahl aufheben" @click="store.surfacePick = null">
        <IconX :size="16" aria-hidden="true" />
      </v-icon-button>
    </header>
    <div class="surface-report__choices">
      <v-btn v-for="surface in choices" :key="surface" variant="outlined" size="small" :disabled="saving || current === surface"
        :aria-pressed="current === surface" @click="report(surface)">
        <template #prepend><i class="surface-report__dot" :style="{ background: routeStyle[surface] }" aria-hidden="true" /></template>
        {{ surfaceLabels[surface] }}
        <template v-if="current === surface" #append><IconCheck :size="14" aria-hidden="true" /></template>
      </v-btn>
      <v-btn v-if="selection.corrected" variant="text" size="small" :disabled="saving" @click="report(null)">
        <template #prepend><IconArrowBackUp :size="16" aria-hidden="true" /></template>
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
.surface-report { display: grid; gap: .4rem; padding: .5rem .6rem .6rem; background: var(--surface); }
header { display: flex; align-items: center; justify-content: space-between; gap: .5rem; font-size: .85rem; font-variant-numeric: tabular-nums; }
.surface-report__choices { display: flex; flex-wrap: wrap; gap: .4rem; }
.surface-report__dot { width: .625rem; height: .625rem; border-radius: 50%; }
</style>

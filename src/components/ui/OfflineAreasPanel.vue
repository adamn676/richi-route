<template>
  <section class="panel-sections" aria-labelledby="offline-title">
    <div class="panel-section">
      <div class="section-heading">
        <v-icon-button class="offline__back" v-tooltip:bottom="'Zurück zur Route (Esc)'" aria-label="Zurück zur Route" @click="offline.close()">
          <IconArrowLeft :size="18" aria-hidden="true" /></v-icon-button>
        <h2 id="offline-title" class="text-title-medium">Offline-Gebiete</h2>
      </div>
      <p class="text-body-small text-medium-emphasis">Karte, Relief und Adresssuche eines Gebiets auf diesem Gerät, für unterwegs ohne Netz.</p>
      <v-alert v-if="offline.error" type="error">{{ offline.error }}</v-alert>
    </div>

    <!-- The area chosen on the map or in the list, and what can be done with it. -->
    <div class="panel-section" aria-live="polite">
      <template v-if="chosen">
        <div class="section-heading"><h3 class="text-title-medium">{{ chosen.name }}</h3></div>
        <p class="text-body-small text-medium-emphasis">{{ chosen.country }} · {{ sizeLabel(chosen.id) }}</p>
        <v-btn v-if="!state" variant="flat" color="primary" :prepend-icon="IconDownload" :disabled="offline.size(chosen.id) === null" @click="offline.load(chosen.id)">Laden</v-btn>
        <template v-else-if="state.status !== 'ready'">
          <div class="offline__progress">
            <v-progress-linear :model-value="state.status === 'loading' ? state.progress * 100 : 0" color="primary" bg-color="surface-variant" bg-opacity="1" height="4" rounded
              :aria-label="`${chosen.name} wird geladen`" />
            <span class="text-body-small text-medium-emphasis">{{ state.status === 'loading' ? `${Math.round(state.progress * 100)} %` : 'Wartet' }}</span>
          </div>
          <v-btn variant="outlined" @click="offline.cancel(chosen.id)">Abbrechen</v-btn>
        </template>
        <template v-else>
          <p class="text-body-small text-medium-emphasis">Geladen am {{ formatDate(state.loadedAt) }}{{ state.outdated ? ' · neuere Daten verfügbar' : '' }}</p>
          <div class="offline__actions">
            <v-btn v-if="state.outdated" variant="flat" color="primary" :prepend-icon="IconRefresh" @click="offline.update(chosen.id)">Aktualisieren</v-btn>
            <v-btn variant="outlined" color="error" :prepend-icon="IconTrash" @click="deleting = chosen">Löschen</v-btn>
          </div>
        </template>
      </template>
      <p v-else class="text-body-small text-medium-emphasis">Ein Gebiet auf der Karte wählen.</p>
    </div>

    <div class="panel-section">
      <div class="section-heading"><h3 class="text-title-medium">Auf diesem Gerät</h3></div>
      <p class="text-body-small text-medium-emphasis">
        {{ kept.length ? `${formatBytes(offline.usedBytes)} belegt` : 'Noch keine Gebiete.' }}<template v-if="offline.free !== null"> · {{ formatBytes(offline.free) }} frei</template></p>
      <v-list v-if="kept.length" class="row-list" lines="two">
        <v-list-item v-for="area in kept" :key="area.id" :title="area.name" :active="offline.selected === area.id" color="primary"
          :subtitle="rowLabel(area.id)" @click="offline.selected = area.id" />
      </v-list>
    </div>

    <v-dialog :model-value="Boolean(deleting)" max-width="400" @update:model-value="open => open || (deleting = null)">
      <v-card title="Gebiet löschen?">
        <v-card-text class="text-body-medium">
          Karte, Relief und Adresssuche von „{{ deleting?.name }}“ werden von diesem Gerät gelöscht. Sie lassen sich wieder laden.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="outlined" @click="deleting = null">Abbrechen</v-btn>
          <v-btn color="error" variant="flat" @click="remove">Löschen</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { IconArrowLeft, IconDownload, IconRefresh, IconTrash } from '@/components/icons';
import { useOfflineAreasStore, type AreaProperties } from '@/stores/offline-areas.store';
import { formatBytes, formatDate } from '@/utils/format';

const offline = useOfflineAreasStore();
const chosen = computed(() => offline.area(offline.selected));
const state = computed(() => chosen.value && offline.states[chosen.value.id]);
// Loading and loaded areas, in the catalogue's order.
const kept = computed(() => offline.areas.filter(area => offline.states[area.id]));
const sizeLabel = (id: string) => { const bytes = offline.size(id); return bytes === null ? 'Größe unbekannt' : formatBytes(bytes); };
function rowLabel(id: string) {
  const area = offline.states[id];
  if (area?.status === 'waiting') return 'Wartet …';
  if (area?.status === 'loading') return `Wird geladen … ${Math.round(area.progress * 100)} %`;
  return area?.outdated ? `${sizeLabel(id)} · neuere Daten verfügbar` : sizeLabel(id);
}

const deleting = ref<AreaProperties | null>(null);
function remove() {
  if (deleting.value) void offline.remove(deleting.value.id);
  deleting.value = null;
}
// Escape leaves the mode, unless a dialog takes it.
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && !deleting.value && !(event.target as HTMLElement | null)?.closest('.v-overlay')) offline.close();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<style scoped>
/* The back arrow's glyph on the margin, as the tools' last glyph sits on the other. */
.offline__back { margin-left: -9px; }
.offline__progress { display: flex; align-items: center; gap: var(--space-3); }
.offline__progress span { min-width: 2.6rem; text-align: right; font-variant-numeric: tabular-nums; }
.panel-section > .v-btn { justify-self: start; }
.offline__actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
</style>

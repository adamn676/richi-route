<template>
  <section class="library panel-sections">
    <!-- Routes replaced without being saved, until they are saved, opened again or a week old. -->
    <div v-if="recent.length" class="panel-section">
      <div class="section-heading"><h2 class="text-title-medium">Zuletzt bearbeitet</h2></div>
      <p class="text-body-small text-medium-emphasis">Nicht gespeichert. Die letzten {{ recentLimit }} Routen bleiben {{ recentDays }} Tage.</p>
      <v-list class="row-list library__recent" lines="two">
        <v-list-item v-for="entry in recent" :key="entry.id" :aria-label="entry.name" :title="entry.name"
          :subtitle="`${formatKm(entry.distanceMeters, 1)} km · ${formatDateTime(entry.updatedAt)}`">
          <template #append>
            <v-icon-button v-tooltip:bottom="'Öffnen'" :disabled="busy" aria-label="Öffnen" @click="openRecentEntry(entry)"><IconFolderOpen :size="18" aria-hidden="true" /></v-icon-button>
            <v-icon-button v-tooltip:bottom="'In „Meine Routen“ speichern'" :disabled="busy" aria-label="Speichern"
              @click="saveRecent(entry)"><IconDeviceFloppy :size="18" aria-hidden="true" /></v-icon-button>
          </template>
        </v-list-item>
      </v-list>
    </div>

    <div class="panel-section">
      <div class="section-heading">
        <h2 ref="heading" class="text-title-medium" tabindex="-1">Gespeicherte Routen <span>{{ entries.length }}</span></h2>
      </div>
      <p class="text-body-small text-medium-emphasis">Nur in diesem Browser. Für ein anderes Gerät die Route als RichiRoute-Datei herunterladen.</p>
      <p v-if="busy || refreshing" class="text-body-small text-medium-emphasis" role="status">Wird aktualisiert …</p>
      <p v-if="!entries.length" class="text-body-small text-medium-emphasis">Noch keine. Gespeichert wird über das Speichern-Symbol im Tab „Route“.</p>
      <v-list v-else class="row-list library__list" lines="two">
        <v-list-item v-for="entry in entries" :key="entry.id" :aria-label="entry.name" :active="active?.id === entry.id"
          color="primary" :title="entry.name" :subtitle="`${formatKm(entry.distanceMeters, 1)} km · ${formatDateTime(entry.updatedAt)}${active?.id === entry.id ? ' · geöffnet' : ''}`">
          <template #append>
            <v-icon-button v-tooltip:bottom="'Öffnen'" :disabled="busy" aria-label="Öffnen" @click="openEntry(entry)"><IconFolderOpen :size="18" aria-hidden="true" /></v-icon-button>
            <v-menu location="bottom end">
              <template #activator="{ props: menu, isActive }">
                <v-icon-button v-bind="menu" v-tooltip:bottom="{ text: 'Weitere Aktionen', disabled: isActive }" :disabled="busy" aria-label="Weitere Aktionen"
                  @click="menuButton = $event.currentTarget">
                  <IconDotsVertical :size="18" aria-hidden="true" /></v-icon-button>
              </template>
              <v-list>
                <v-list-item :prepend-icon="IconCopy" title="Duplizieren" :disabled="busy" @click="duplicate(entry)" />
                <v-list-item :prepend-icon="IconPencil" title="Umbenennen" :disabled="busy" @click="startRename(entry)" />
                <v-list-item :prepend-icon="IconTrash" title="Löschen" base-color="error" :disabled="busy" @click="deleting = entry" />
              </v-list>
            </v-menu>
          </template>
        </v-list-item>
      </v-list>
    </div>


    <v-dialog :model-value="Boolean(renaming)" max-width="400" @update:model-value="open => open || (renaming = undefined)" @after-leave="returnFocus">
      <v-card title="Route umbenennen">
        <form @submit.prevent="finishRename">
          <v-card-text>
            <v-text-field v-model="renameValue" label="Neuer Routenname" maxlength="120" autofocus required @focus="($event.target as HTMLInputElement).select()" />
            <v-alert v-if="error" type="error" class="mt-3">{{ error }}</v-alert>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="outlined" :disabled="busy" @click="renaming = undefined">Abbrechen</v-btn>
            <v-btn type="submit" variant="flat" :disabled="busy || !renameValue.trim()">Umbenennen</v-btn>
          </v-card-actions>
        </form>
      </v-card>
    </v-dialog>
    <v-dialog :model-value="Boolean(deleting)" max-width="400" @update:model-value="open => open || (deleting = undefined)" @after-leave="returnFocus">
      <v-card title="Route löschen?">
        <v-card-text class="text-body-medium">
          „{{ deleting?.name }}“ wird endgültig aus „Meine Routen“ gelöscht.
          <v-alert v-if="error" type="error" class="mt-3">{{ error }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="outlined" :disabled="busy" @click="deleting = undefined">Abbrechen</v-btn>
          <v-btn color="error" variant="flat" :disabled="busy" @click="finishDelete">Endgültig löschen</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>

<script setup lang="ts">
import { ref, shallowRef } from 'vue';
import { IconCopy, IconDeviceFloppy, IconDotsVertical, IconFolderOpen, IconPencil, IconTrash } from '@/components/icons';
import type { useRouteLibrary } from '../../composables/useRouteLibrary';
import type { SavedRouteSummary } from '../../domain/saved-route';
import { formatDateTime, formatKm } from '@/utils/format';
import { recentDays, recentLimit } from '../../services/recent-routes.service';

const props = defineProps<{ library: ReturnType<typeof useRouteLibrary> }>();
const emit = defineEmits<{ opened: [] }>();
const { entries, recent, active, busy, refreshing, error, open, openRecent, saveRecent, rename, duplicate, remove } = props.library;
const renaming = shallowRef<SavedRouteSummary>();
const deleting = shallowRef<SavedRouteSummary>();
const renameValue = ref('');
// One date in both lists, with the time, which tells the recently edited ones apart.
// An opened route shows on the Route tab, as a new route and an opened track do.
async function openEntry(entry: SavedRouteSummary) {
  if (await open(entry)) emit('opened');
}
async function openRecentEntry(entry: SavedRouteSummary) {
  if (await openRecent(entry)) emit('opened');
}
// The dialogs open from a row's menu, so closing one returns to that menu's button, or after a deletion to the heading.
const heading = ref<HTMLElement>();
const menuButton = shallowRef<EventTarget | null>(null);
function returnFocus() {
  (menuButton.value instanceof HTMLElement && menuButton.value.isConnected ? menuButton.value : heading.value)?.focus();
}

function startRename(entry: SavedRouteSummary) {
  renaming.value = entry;
  renameValue.value = entry.name;
}
async function finishRename() {
  if (!renaming.value) return;
  await rename(renaming.value, renameValue.value);
  if (!error.value) renaming.value = undefined;
}
async function finishDelete() {
  if (!deleting.value) return;
  await remove(deleting.value);
  if (!error.value) deleting.value = undefined;
}
</script>

<style scoped>
h2 span { margin-left: .3rem; color: var(--text-muted); font-weight: 500; font-variant-numeric: tabular-nums; }
</style>

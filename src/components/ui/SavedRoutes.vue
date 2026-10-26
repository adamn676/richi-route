<template>
  <section class="library">
    <form class="library__save" @submit.prevent="save()">
      <v-text-field v-model="name" label="Routenname" placeholder="z. B. Feierabendrunde" maxlength="120" required />
      <v-btn type="submit" variant="flat" :prepend-icon="IconDeviceFloppy" :disabled="busy || !hasDraft || !name.trim()"
        :aria-label="active ? 'Änderungen speichern' : 'Route speichern'">Speichern</v-btn>
      <v-icon-button v-if="active" v-tooltip:bottom="'Als Kopie speichern'" size="default" :disabled="busy || !hasDraft || !name.trim()"
        aria-label="Als Kopie speichern" @click="save(true)"><IconCopy :size="18" aria-hidden="true" /></v-icon-button>
    </form>

    <div class="library__group">
      <div class="library__heading">
        <h2 ref="heading" class="text-title-medium" tabindex="-1">Gespeicherte Routen <span>{{ entries.length }}</span></h2>
        <v-icon-button v-tooltip:bottom="'Liste aktualisieren'" :disabled="busy" aria-label="Aktualisieren"
          @click="refreshList"><IconRefresh :size="16" aria-hidden="true" /></v-icon-button>
      </div>
      <p v-if="busy" class="text-body-small text-medium-emphasis" role="status">Wird aktualisiert …</p>
      <p v-if="!entries.length" class="text-body-small text-medium-emphasis">Noch keine gespeicherten Routen.</p>
      <v-list v-else class="library__list" lines="two">
        <v-list-item v-for="entry in entries" :key="entry.id" :aria-label="entry.name" :active="active?.id === entry.id"
          color="primary" :title="entry.name" :subtitle="`${formatKm(entry.distanceMeters, 1)} km · ${dateLabel(entry.updatedAt)}${active?.id === entry.id ? ' · geöffnet' : ''}`">
          <template #append>
            <v-icon-button v-tooltip:bottom="'Öffnen'" :disabled="busy" aria-label="Öffnen" @click="open(entry)"><IconFolderOpen :size="17" aria-hidden="true" /></v-icon-button>
            <v-menu location="bottom end">
              <template #activator="{ props: menu, isActive }">
                <v-icon-button v-bind="menu" v-tooltip:bottom="{ text: 'Weitere Aktionen', disabled: isActive }" :disabled="busy" aria-label="Weitere Aktionen"
                  @click="menuButton = $event.currentTarget">
                  <IconDotsVertical :size="17" aria-hidden="true" /></v-icon-button>
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

    <footer class="library__backup">
      <p class="text-body-small text-medium-emphasis">Routen bleiben nur in diesem Browser. Eine Sicherungsdatei bringt sie auf ein anderes Gerät.</p>
      <v-btn variant="outlined" size="small" :prepend-icon="IconDownload" :disabled="busy || !hasDraft" @click="download">Aktuelle Route sichern</v-btn>
      <v-btn variant="outlined" size="small" :prepend-icon="IconUpload" :disabled="busy" @click="fileInput?.click()">Sicherung einlesen</v-btn>
      <input ref="fileInput" type="file" accept=".json,application/json" aria-label="RichiRoute-Sicherung auswählen" hidden @change="importSelected" />
    </footer>

    <v-dialog :model-value="Boolean(renaming)" max-width="400" @update:model-value="open => open || (renaming = undefined)" @after-leave="returnFocus">
      <v-card title="Route umbenennen">
        <form @submit.prevent="finishRename">
          <v-card-text>
            <v-text-field v-model="renameValue" label="Neuer Routenname" maxlength="120" autofocus required />
            <v-alert v-if="error" type="error" class="mt-3">{{ error }}</v-alert>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" :disabled="busy" @click="renaming = undefined">Abbrechen</v-btn>
            <v-btn type="submit" variant="flat" :disabled="busy || !renameValue.trim()">Namen speichern</v-btn>
          </v-card-actions>
        </form>
      </v-card>
    </v-dialog>
    <v-dialog :model-value="Boolean(deleting)" max-width="400" @update:model-value="open => open || (deleting = undefined)" @after-leave="returnFocus">
      <v-card title="Route löschen?">
        <v-card-text>
          „{{ deleting?.name }}“ wird endgültig aus „Meine Routen“ gelöscht.
          <v-alert v-if="error" type="error" class="mt-3">{{ error }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="busy" @click="deleting = undefined">Abbrechen</v-btn>
          <v-btn color="error" variant="flat" :disabled="busy" @click="finishDelete">Endgültig löschen</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>

<script setup lang="ts">
import { ref, shallowRef } from 'vue';
import { IconCopy, IconDeviceFloppy, IconDotsVertical, IconDownload, IconFolderOpen, IconPencil, IconRefresh, IconTrash, IconUpload } from '@/components/icons';
import type { useRouteLibrary } from '../../composables/useRouteLibrary';
import type { SavedRouteSummary } from '../../domain/saved-route';
import { formatKm } from '@/utils/format';

const props = defineProps<{ library: ReturnType<typeof useRouteLibrary> }>();
const { entries, active, name, busy, error, hasDraft, save, open, rename, duplicate, remove,
  importFile, download, refreshList } = props.library;
const fileInput = ref<HTMLInputElement>();
const renaming = shallowRef<SavedRouteSummary>();
const deleting = shallowRef<SavedRouteSummary>();
const renameValue = ref('');
const dateLabel = (date: string) => new Date(date).toLocaleDateString('de-AT');
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
async function importSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) await importFile(file);
  input.value = '';
}
</script>

<style scoped>
.library { display: grid; gap: 1.25rem; padding: 1rem var(--gutter) 1.5rem; }
.library__save { display: flex; align-items: center; gap: .4rem; }
.library__group { display: grid; gap: .5rem; }
.library__heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
h2 span { margin-left: .3rem; color: var(--text-muted); font-weight: 500; font-variant-numeric: tabular-nums; }
.library__list { padding: 0; border-top: 1px solid var(--border); }
.library__list :deep(.v-list-item) { border-bottom: 1px solid var(--border); }
.library__list :deep(.v-list-item-title) { white-space: normal; overflow-wrap: anywhere; }
.library__backup { display: flex; flex-wrap: wrap; gap: .4rem; padding-top: 1rem; border-top: 1px solid var(--border); }
.library__backup p { flex-basis: 100%; margin: 0 0 .2rem; }
</style>

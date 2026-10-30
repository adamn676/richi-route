<template>
  <section class="library">
    <form class="library__save" @submit.prevent="save()">
      <v-text-field v-model="name" label="Routenname" placeholder="z. B. Feierabendrunde" persistent-placeholder maxlength="120" required />
      <v-btn type="submit" variant="flat" :prepend-icon="IconDeviceFloppy" :disabled="busy || !hasDraft || !name.trim()"
        :aria-label="active ? 'Änderungen speichern' : 'Route speichern'">Speichern</v-btn>
      <v-icon-button v-if="active" v-tooltip:bottom="'Als Kopie speichern'" size="default" :disabled="busy || !hasDraft || !name.trim()"
        aria-label="Als Kopie speichern" @click="save(true)"><IconCopy :size="18" aria-hidden="true" /></v-icon-button>
    </form>

    <!-- Routes replaced without being saved, until they are saved, opened again or a week old. -->
    <div v-if="recent.length" class="library__group">
      <div class="section-heading"><h2 class="text-title-medium">Zuletzt bearbeitet</h2></div>
      <p class="text-body-small text-medium-emphasis">Nicht gespeichert. Die letzten {{ recentLimit }} Routen bleiben {{ recentDays }} Tage.</p>
      <v-list class="library__rows library__recent" lines="two">
        <v-list-item v-for="entry in recent" :key="entry.id" :aria-label="entry.name" :title="entry.name"
          :subtitle="`${formatKm(entry.distanceMeters, 1)} km · ${timeLabel(entry.updatedAt)}`">
          <template #append>
            <v-icon-button v-tooltip:bottom="'Öffnen'" :disabled="busy" aria-label="Öffnen" @click="openRecentEntry(entry)"><IconFolderOpen :size="17" aria-hidden="true" /></v-icon-button>
            <v-icon-button v-tooltip:bottom="'In „Meine Routen“ speichern'" :disabled="busy" aria-label="Speichern"
              @click="saveRecent(entry)"><IconDeviceFloppy :size="17" aria-hidden="true" /></v-icon-button>
          </template>
        </v-list-item>
      </v-list>
    </div>

    <div class="library__group">
      <div class="section-heading">
        <h2 ref="heading" class="text-title-medium" tabindex="-1">Gespeicherte Routen <span>{{ entries.length }}</span></h2>
        <v-icon-button v-tooltip:bottom="'Liste aktualisieren'" :disabled="busy" aria-label="Aktualisieren"
          @click="refreshList"><IconRefresh :size="18" aria-hidden="true" /></v-icon-button>
      </div>
      <p v-if="busy || refreshing" class="text-body-small text-medium-emphasis" role="status">Wird aktualisiert …</p>
      <p v-if="!entries.length" class="text-body-small text-medium-emphasis">Noch keine gespeicherten Routen.</p>
      <v-list v-else class="library__rows library__list" lines="two">
        <v-list-item v-for="entry in entries" :key="entry.id" :aria-label="entry.name" :active="active?.id === entry.id"
          color="primary" :title="entry.name" :subtitle="`${formatKm(entry.distanceMeters, 1)} km · ${dateLabel(entry.updatedAt)}${active?.id === entry.id ? ' · geöffnet' : ''}`">
          <template #append>
            <v-icon-button v-tooltip:bottom="'Öffnen'" :disabled="busy" aria-label="Öffnen" @click="openEntry(entry)"><IconFolderOpen :size="17" aria-hidden="true" /></v-icon-button>
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
      <div class="library__actions">
        <v-btn variant="outlined" size="small" :prepend-icon="IconDownload" :disabled="busy || !hasDraft" @click="download">Aktuelle Route sichern</v-btn>
        <v-btn variant="outlined" size="small" :prepend-icon="IconUpload" :disabled="busy" @click="fileInput?.click()">Sicherung einlesen</v-btn>
      </div>
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
import { recentDays, recentLimit } from '../../services/recent-routes.service';

const props = defineProps<{ library: ReturnType<typeof useRouteLibrary> }>();
const emit = defineEmits<{ opened: [] }>();
const { entries, recent, active, name, busy, refreshing, error, hasDraft, save, open, openRecent, saveRecent, rename, duplicate, remove,
  importFile, download, refreshList } = props.library;
const fileInput = ref<HTMLInputElement>();
const renaming = shallowRef<SavedRouteSummary>();
const deleting = shallowRef<SavedRouteSummary>();
const renameValue = ref('');
const dateLabel = (date: string) => new Date(date).toLocaleDateString('de-AT');
const timeLabel = (date: string) => new Date(date).toLocaleString('de-AT', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
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
async function importSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) await importFile(file);
  input.value = '';
}
</script>

<style scoped>
/* Sections as in the Route tab: 16 px above and below, a line from margin to margin between them. */
.library { display: grid; padding: 0 var(--gutter-end) 0 var(--gutter); }
/* As the Route tab's sections, measured to what shows: 24 px from a line to the first letters and from the last item to
   the next line. A heading row brings 12 px of its own; the saving field's label rises 4 px above the field; a paragraph
   is trimmed to its letters where the browser can. */
.library > * { padding-block: var(--space-3) var(--space-6); }
.library__save { padding-top: calc(var(--space-6) + 4px); }
.library__backup { padding-top: var(--space-6); }
.library__group p { text-box: trim-end cap alphabetic; }
.library__backup p { text-box: trim-start cap alphabetic; }
.library > * + * { border-top: 1px solid var(--border); }
.library__save { display: flex; align-items: center; gap: var(--space-2); }
.library__group { display: grid; gap: var(--space-3); }
.library__group p { margin: 0; }
h2 span { margin-left: .3rem; color: var(--text-muted); font-weight: 500; font-variant-numeric: tabular-nums; }
.library__rows { padding: 0; border-top: 1px solid var(--border); }
.library__rows :deep(.v-list-item) { border-bottom: 1px solid var(--border); }
.library__rows :deep(.v-list-item-title) { white-space: normal; overflow-wrap: anywhere; }
.library__backup { display: grid; gap: var(--space-3); }
.library__backup p { margin: 0; }
.library__actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
</style>

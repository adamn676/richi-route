<template>
  <section class="library">
    <form class="library__save" @submit.prevent="save()">
      <div class="library__save-row">
        <div class="float library__name"><input id="route-name" v-model="name" class="field" maxlength="120" placeholder="z. B. Feierabendrunde" required />
          <label for="route-name">Routenname</label></div>
        <button type="submit" class="btn btn--primary" :disabled="busy || !hasDraft || !name.trim()"
          :aria-label="active ? 'Änderungen speichern' : 'Route speichern'">
          <IconDeviceFloppy :size="16" aria-hidden="true" />Speichern
        </button>
        <button v-if="active" type="button" class="btn btn--icon" :disabled="busy || !hasDraft || !name.trim()"
          aria-label="Als Kopie speichern" title="Als Kopie speichern" @click="save(true)"><IconCopy :size="18" aria-hidden="true" /></button>
      </div>
    </form>

    <div class="library__group">
      <div class="library__heading">
        <h2 class="section-title">Gespeicherte Routen <span>{{ entries.length }}</span></h2>
        <button type="button" class="btn btn--ghost btn--icon btn--sm" :disabled="busy" aria-label="Aktualisieren" title="Liste aktualisieren"
          @click="refreshList"><IconRefresh :size="16" aria-hidden="true" /></button>
      </div>
      <p v-if="busy" class="muted" role="status">Wird aktualisiert …</p>
      <p v-if="!entries.length" class="muted">Noch keine gespeicherten Routen.</p>
      <ul v-else class="library__list">
        <li v-for="entry in entries" :key="entry.id" :aria-label="entry.name" :class="{ 'library__item--active': active?.id === entry.id }">
          <div class="library__entry">
            <div class="library__title">
              <strong>{{ entry.name }}</strong>
              <span class="muted">{{ formatKm(entry.distanceMeters, 1) }} km · {{ dateLabel(entry.updatedAt) }}<template v-if="active?.id === entry.id"> · <span class="library__current">geöffnet</span></template></span>
            </div>
            <div v-if="renaming?.id !== entry.id && deleting?.id !== entry.id" class="library__tools">
              <button type="button" class="btn btn--ghost btn--icon btn--sm" :disabled="busy" aria-label="Öffnen" title="Öffnen" @click="open(entry)"><IconFolderOpen :size="17" aria-hidden="true" /></button>
              <button type="button" class="btn btn--ghost btn--icon btn--sm" :disabled="busy" aria-label="Duplizieren" title="Duplizieren" @click="duplicate(entry)"><IconCopy :size="17" aria-hidden="true" /></button>
              <button type="button" class="btn btn--ghost btn--icon btn--sm" :disabled="busy" aria-label="Umbenennen" title="Umbenennen" @click="startRename(entry)"><IconPencil :size="17" aria-hidden="true" /></button>
              <button type="button" class="btn btn--ghost btn--icon btn--sm" :disabled="busy" aria-label="Löschen" title="Löschen" @click="deleting = entry; renaming = undefined"><IconTrash :size="17" aria-hidden="true" /></button>
            </div>
          </div>
          <form v-if="renaming?.id === entry.id" class="library__inline" @submit.prevent="finishRename(entry)">
            <div class="float library__name"><input :id="`rename-${entry.id}`" v-model="renameValue" class="field" maxlength="120" placeholder=" " required />
              <label :for="`rename-${entry.id}`">Neuer Routenname</label></div>
            <button type="submit" class="btn btn--primary btn--sm" :disabled="busy || !renameValue.trim()">Namen speichern</button>
            <button type="button" class="btn btn--sm" :disabled="busy" @click="renaming = undefined">Abbrechen</button>
          </form>
          <div v-else-if="deleting?.id === entry.id" class="library__inline">
            <span class="muted">Diese Route löschen?</span>
            <button type="button" class="btn btn--danger btn--sm" :disabled="busy" @click="finishDelete(entry)">Endgültig löschen</button>
            <button type="button" class="btn btn--sm" :disabled="busy" @click="deleting = undefined">Abbrechen</button>
          </div>
        </li>
      </ul>
    </div>

    <footer class="library__backup">
      <div class="library__backup-actions">
        <button type="button" class="btn btn--sm" :disabled="busy || !hasDraft" aria-label="Sicherung herunterladen"
          title="Die aktuelle Route als Datei sichern; Routen bleiben sonst nur in diesem Browser" @click="download"><IconDownload :size="16" aria-hidden="true" />Herunterladen</button>
        <button type="button" class="btn btn--sm" :disabled="busy" aria-label="Sicherung importieren"
          title="Eine RichiRoute-Sicherung zu „Meine Routen“ hinzufügen" @click="fileInput?.click()"><IconUpload :size="16" aria-hidden="true" />Importieren</button>
        <input ref="fileInput" type="file" accept=".json,application/json" aria-label="RichiRoute-Sicherung auswählen" hidden @change="importSelected" />
      </div>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { nextTick, ref, shallowRef } from 'vue';
import { IconCopy, IconDeviceFloppy, IconDownload, IconFolderOpen, IconPencil, IconRefresh, IconTrash, IconUpload } from '@/components/icons';
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

async function startRename(entry: SavedRouteSummary) {
  renaming.value = entry;
  deleting.value = undefined;
  renameValue.value = entry.name;
  await nextTick();
  document.getElementById(`rename-${entry.id}`)?.focus();
}
async function finishRename(entry: SavedRouteSummary) {
  await rename(renaming.value ?? entry, renameValue.value);
  if (!error.value) renaming.value = undefined;
}
async function finishDelete(entry: SavedRouteSummary) {
  await remove(deleting.value ?? entry);
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
.library__save { display: grid; gap: .4rem; }
.library__save .label { margin: 0; }
.library__save-row, .library__inline { display: flex; gap: .4rem; }
.library__name { flex: 1; min-width: 0; }
.library__group { display: grid; gap: .5rem; }
.library__heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
h2 span { margin-left: .3rem; color: var(--text-muted); font-weight: 500; font-variant-numeric: tabular-nums; }
.library__list { display: grid; margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--border); }
.library__list > li { display: grid; gap: .5rem; padding: .6rem .5rem; border-bottom: 1px solid var(--border); }
.library__list > li.library__item--active { background: var(--accent-soft); }
.library__entry { display: flex; align-items: center; gap: .5rem; }
.library__title { display: grid; flex: 1; min-width: 0; gap: .1rem; }
.library__title strong { font-size: .88rem; font-weight: 600; overflow-wrap: anywhere; }
.library__title .muted { font-size: .75rem; font-variant-numeric: tabular-nums; }
.library__current { color: var(--accent-hover); font-weight: 600; }
.library__tools { display: flex; flex-shrink: 0; }
.library__inline { flex-wrap: wrap; align-items: center; }
.library__inline .library__name { flex: 1 1 10rem; }
.library__backup { display: grid; gap: .5rem; padding-top: 1rem; border-top: 1px solid var(--border); }
.library__backup-actions { display: flex; flex-wrap: wrap; gap: .4rem; }
</style>

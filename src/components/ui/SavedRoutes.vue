<template>
  <section class="library">
    <form class="library__form" @submit.prevent="save()">
      <label for="route-name" class="label">Routenname</label>
      <input id="route-name" v-model="name" class="field" maxlength="120" placeholder="Zum Beispiel: Feierabendrunde" required />
      <div class="library__actions">
        <button type="submit" class="btn btn--primary" :disabled="busy || !hasDraft || !name.trim()">
          <IconDeviceFloppy :size="16" aria-hidden="true" />{{ active ? 'Änderungen speichern' : 'Route speichern' }}
        </button>
        <button v-if="active" type="button" class="btn" :disabled="busy || !hasDraft || !name.trim()" @click="save(true)">Als Kopie speichern</button>
      </div>
      <p v-if="active" class="muted">Änderungen an der geöffneten Route mit „Änderungen speichern“ übernehmen.</p>
    </form>

    <div class="library__group">
      <p v-if="busy" class="muted" role="status">Routenspeicher wird aktualisiert …</p>
      <div class="library__heading">
        <h2 class="section-title">Gespeicherte Routen <span>{{ entries.length }}</span></h2>
        <button type="button" class="btn btn--ghost btn--sm" :disabled="busy" @click="refreshList"><IconRefresh :size="16" aria-hidden="true" />Aktualisieren</button>
      </div>
      <p v-if="!entries.length" class="muted">Noch keine gespeicherten Routen. Plane eine Route und gib ihr oben einen Namen.</p>
      <ul v-else class="library__list">
        <li v-for="entry in entries" :key="entry.id" :aria-label="entry.name" :class="{ 'library__item--active': active?.id === entry.id }">
          <div class="library__title">
            <strong>{{ entry.name }}</strong>
            <span v-if="active?.id === entry.id" class="library__current">Geöffnet</span>
          </div>
          <p class="muted">{{ (entry.distanceMeters / 1000).toLocaleString('de-AT', { maximumFractionDigits: 1 }) }} km · {{ entry.pointCount }} Punkte · {{ dateLabel(entry.updatedAt) }}</p>
          <form v-if="renaming?.id === entry.id" class="library__form" @submit.prevent="finishRename(entry)">
            <label :for="`rename-${entry.id}`" class="label">Neuer Routenname</label>
            <input :id="`rename-${entry.id}`" v-model="renameValue" class="field" maxlength="120" required />
            <div class="library__actions">
              <button type="submit" class="btn btn--primary btn--sm" :disabled="busy || !renameValue.trim()">Namen speichern</button>
              <button type="button" class="btn btn--sm" :disabled="busy" @click="renaming = undefined">Abbrechen</button>
            </div>
          </form>
          <template v-else-if="deleting?.id === entry.id">
            <p class="muted">„{{ entry.name }}“ aus den gespeicherten Routen löschen?</p>
            <div class="library__actions">
              <button type="button" class="btn btn--danger btn--sm" :disabled="busy" @click="finishDelete(entry)">Endgültig löschen</button>
              <button type="button" class="btn btn--sm" :disabled="busy" @click="deleting = undefined">Abbrechen</button>
            </div>
          </template>
          <div v-else class="library__actions">
            <button type="button" class="btn btn--sm" :disabled="busy" @click="open(entry)"><IconFolderOpen :size="16" aria-hidden="true" />Öffnen</button>
            <button type="button" class="btn btn--ghost btn--sm" :disabled="busy" @click="duplicate(entry)">Duplizieren</button>
            <button type="button" class="btn btn--ghost btn--sm" :disabled="busy" @click="startRename(entry)">Umbenennen</button>
            <button type="button" class="btn btn--ghost btn--sm" :disabled="busy" @click="deleting = entry; renaming = undefined">Löschen</button>
          </div>
        </li>
      </ul>
    </div>

    <div class="library__group">
      <h2 class="section-title">Sicherung</h2>
      <p class="muted">Routen bleiben in diesem Browser. Lade eine Sicherung herunter, um sie auch außerhalb des Browsers aufzubewahren.</p>
      <div class="library__actions">
        <button type="button" class="btn" :disabled="busy || !hasDraft" @click="download"><IconDownload :size="16" aria-hidden="true" />Sicherung herunterladen</button>
        <button type="button" class="btn" :disabled="busy" @click="fileInput?.click()"><IconUpload :size="16" aria-hidden="true" />Sicherung importieren</button>
        <input ref="fileInput" class="library__file" type="file" accept=".json,application/json" aria-label="RichiRoute-Sicherung auswählen" @change="importSelected" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { nextTick, ref, shallowRef } from 'vue';
import { IconDeviceFloppy, IconDownload, IconFolderOpen, IconRefresh, IconUpload } from '@/components/icons';
import type { useRouteLibrary } from '../../composables/useRouteLibrary';
import type { SavedRouteSummary } from '../../domain/saved-route';

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
.library__form, .library__group { display: grid; gap: .5rem; }
.library__group { padding-top: 1.25rem; border-top: 1px solid var(--border); }
.library__actions { display: flex; flex-wrap: wrap; gap: .4rem; }
h2 span { margin-left: .3rem; color: var(--text-muted); font-weight: 500; font-variant-numeric: tabular-nums; }
.library__heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.library__list { display: grid; gap: .5rem; max-height: 26rem; margin: 0; padding: 0; overflow-y: auto; list-style: none; }
.library__list > li { display: grid; gap: .35rem; padding: .7rem .75rem; border: 1px solid var(--border); border-radius: var(--radius-lg); }
.library__list > li.library__item--active { border-color: var(--accent); background: var(--accent-soft); }
.library__title { display: flex; align-items: baseline; gap: .5rem; }
.library__title strong { font-size: .9rem; font-weight: 600; overflow-wrap: anywhere; }
.library__current { color: var(--accent-hover); font-size: .75rem; font-weight: 600; }
.library__file { display: none; }
</style>

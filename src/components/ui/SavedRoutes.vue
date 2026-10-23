<template>
  <section class="library" aria-label="Meine Routen">
    <details>
      <summary>Meine Routen <span>{{ entries.length }}</span></summary>
      <p class="library__help">Routen bleiben in diesem Browser. Lade eine Sicherung herunter, um sie auch außerhalb des Browsers aufzubewahren.</p>
      <p v-if="active" class="library__help">Änderungen an der geöffneten Route mit „Änderungen speichern“ übernehmen.</p>
      <form class="library__save" @submit.prevent="save()">
        <label for="route-name">Routenname</label>
        <input id="route-name" v-model="name" maxlength="120" placeholder="Zum Beispiel: Feierabendrunde" :disabled="busy" required />
        <div class="library__actions">
          <button type="submit" :disabled="busy || !hasDraft || !name.trim()">{{ active ? 'Änderungen speichern' : 'Route speichern' }}</button>
          <button v-if="active" type="button" :disabled="busy || !hasDraft || !name.trim()" @click="save(true)">Als Kopie speichern</button>
        </div>
      </form>
      <div class="library__actions">
        <button type="button" :disabled="busy || !hasDraft" @click="download">Sicherung herunterladen</button>
        <button type="button" :disabled="busy" @click="fileInput?.click()">Sicherung importieren</button>
        <input ref="fileInput" class="library__file" type="file" accept=".json,application/json" aria-label="RichiRoute-Sicherung auswählen" @change="importSelected" />
      </div>
      <div class="library__heading">
        <h2>Gespeicherte Routen</h2>
        <button type="button" :disabled="busy" @click="refreshList">Aktualisieren</button>
      </div>
      <p v-if="!entries.length" class="library__help">Noch keine gespeicherten Routen.</p>
      <ul v-else class="library__list">
        <li v-for="entry in entries" :key="entry.id" :aria-label="entry.name">
          <strong>{{ entry.name }}</strong>
          <span v-if="active?.id === entry.id" class="library__current">Geöffnet</span>
          <p class="library__help">{{ (entry.distanceMeters / 1000).toLocaleString('de-AT', { maximumFractionDigits: 1 }) }} km · {{ entry.pointCount }} Punkte · {{ dateLabel(entry.updatedAt) }}</p>
          <form v-if="renaming?.id === entry.id" @submit.prevent="finishRename(entry)">
            <label :for="`rename-${entry.id}`">Neuer Routenname</label>
            <input :id="`rename-${entry.id}`" v-model="renameValue" maxlength="120" required :disabled="busy" />
            <div class="library__actions">
              <button type="submit" :disabled="busy || !renameValue.trim()">Namen speichern</button>
              <button type="button" :disabled="busy" @click="renaming = undefined">Abbrechen</button>
            </div>
          </form>
          <div v-else-if="deleting?.id === entry.id">
            <p class="library__help">„{{ entry.name }}“ aus den gespeicherten Routen löschen?</p>
            <div class="library__actions">
              <button type="button" :disabled="busy" @click="finishDelete(entry)">Endgültig löschen</button>
              <button type="button" :disabled="busy" @click="deleting = undefined">Abbrechen</button>
            </div>
          </div>
          <div v-else class="library__actions">
            <button type="button" :disabled="busy" @click="open(entry)">Öffnen</button>
            <button type="button" :disabled="busy" @click="duplicate(entry)">Duplizieren</button>
            <button type="button" :disabled="busy" @click="startRename(entry)">Umbenennen</button>
            <button type="button" :disabled="busy" @click="deleting = entry; renaming = undefined">Löschen</button>
          </div>
        </li>
      </ul>
    </details>
    <p v-if="busy" class="library__help" role="status">Routenspeicher wird aktualisiert …</p>
    <p v-if="error" class="library__error" role="alert">{{ error }}</p>
    <p v-else-if="message" class="library__help" role="status">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, shallowRef } from 'vue';
import { useRouteLibrary } from '../../composables/useRouteLibrary';
import { hasDraftPoints } from '../../domain/route-draft';
import type { SavedRouteSummary } from '../../domain/saved-route';
import { useRouteStore } from '../../stores/route.store';

const store = useRouteStore();
const { entries, active, name, busy, error, message, save, open, newRoute, rename, duplicate, remove,
  importFile, download, refreshList } = useRouteLibrary();
const hasDraft = computed(() => hasDraftPoints(store.points));
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
defineExpose({ newRoute });
</script>

<style scoped>
.library { border-block: 1px solid #d8e4e1; padding-block: .75rem; }
summary { cursor: pointer; font-weight: 700; font-size: .9rem; }
summary span { float: right; font-weight: 400; color: #60757b; }
.library__help { color: #60757b; font-size: .76rem; line-height: 1.5; margin: .5rem 0; overflow-wrap: anywhere; }
.library__save { display: grid; gap: .4rem; margin-block: .75rem; }
.library label { display: block; font-size: .8rem; font-weight: 600; margin-bottom: .2rem; }
.library input { width: 100%; min-width: 0; padding: .5rem; border: 1px solid #cddbd9; border-radius: .4rem; background: white; color: #19343c; }
.library__actions { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .4rem; }
.library button { min-height: 2.2rem; padding: .4rem .6rem; font-size: .75rem; border: 1px solid #cddbd9; border-radius: .4rem; background: white; color: #16515a; }
.library button:hover:not(:disabled) { background: #e9f5f1; border-color: #08796f; }
.library__heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-top: 1rem; }
.library h2 { font-size: .85rem; margin: 0; }
.library__list { list-style: none; margin: .5rem 0 0; padding: 0; max-height: 24rem; overflow-y: auto; }
.library__list li { padding: .75rem 0; border-top: 1px solid #d8e4e1; }
.library__list strong { font-size: .85rem; overflow-wrap: anywhere; }
.library__current { display: inline-block; margin-left: .4rem; color: #0b706c; font-size: .7rem; }
.library__error { color: #812f23; background: #fff1ed; padding: .6rem; border-radius: .4rem; font-size: .8rem; }
.library__file { display: none; }
</style>

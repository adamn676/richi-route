import { computed, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import type { FeatureCollection, MultiPolygon } from 'geojson';
import { areaFiles, download, forgetStored, keepStored, loadCatalogue, removeFiles, setDeviceAreas, signature, storedAreas, type Catalogue,
  type CatalogueFile, type StoredArea } from '@/services/offline-storage';

export interface AreaProperties { id: string; name: string; country: string; label: [number, number] }
export type AreaState = { status: 'waiting' } | { status: 'loading'; progress: number } | { status: 'ready'; loadedAt: number; outdated: boolean };

// Areas to take onto the device: their outlines (public/offline-areas.json), the catalogue of their packages, and what
// is on the device. The mode shows them on the map and in the sidebar in place of the route. Areas load one after
// another, since neighbours share their routing squares.
export const useOfflineAreasStore = defineStore('offline-areas', () => {
  const active = ref(false);
  const selected = ref<string | null>(null);
  const outlines = shallowRef<FeatureCollection<MultiPolygon, AreaProperties> | null>(null);
  const catalogue = shallowRef<Catalogue | null>(null);
  const stored = ref<Record<string, StoredArea>>({});
  const loading = ref<Record<string, AreaState>>({});
  const free = ref<number | null>(null);
  const error = ref('');

  const entry = (id: string) => catalogue.value?.areas.find(area => area.id === id);
  const files = (id: string): CatalogueFile[] => { const area = entry(id); return area && catalogue.value ? areaFiles(catalogue.value, area) : []; };
  const states = computed<Record<string, AreaState>>(() => ({
    ...Object.fromEntries(Object.values(stored.value).map(area => [area.id, { status: 'ready', loadedAt: area.loadedAt,
      outdated: files(area.id).some(file => area.files[file.path] !== signature(file)) }])),
    ...loading.value,
  }));

  async function measure() {
    const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
    free.value = estimate?.quota === undefined ? null : estimate.quota - (estimate.usage ?? 0);
  }
  async function open() {
    active.value = true;
    error.value = '';
    try {
      const [areas, packages, kept] = await Promise.all([
        outlines.value ?? fetch('/offline-areas.json').then(response => response.json()),
        catalogue.value ?? loadCatalogue(), storedAreas()]);
      outlines.value = areas;
      catalogue.value = packages;
      stored.value = Object.fromEntries(kept.map(area => [area.id, area]));
    } catch {
      error.value = 'Die Gebiete ließen sich nicht laden. Ohne Netz zeigt die Liste nur, was schon auf dem Gerät ist.';
    }
    await measure();
  }
  // What is on the device, from the start: the map draws from it.
  async function init() {
    stored.value = Object.fromEntries((await storedAreas()).map(area => [area.id, area]));
  }
  watch(stored, areas => setDeviceAreas(Object.values(areas).map(({ id, bounds }) => ({ id, bounds }))), { deep: true });
  function close() {
    active.value = false;
    selected.value = null;
  }

  const areas = computed(() => outlines.value?.features.map(feature => feature.properties) ?? []);
  const area = (id: string | null) => areas.value.find(item => item.id === id) ?? null;
  // Shared routing squares count once.
  const bytesOf = (ids: string[]) => [...new Map(ids.flatMap(files).map(file => [file.path, file.bytes])).values()].reduce((a, b) => a + b, 0);
  const size = (id: string) => entry(id) ? bytesOf([id]) : null;
  const usedBytes = computed(() => bytesOf(Object.keys(stored.value)));
  // An area's files no other area on the device (or about to be) needs.
  const ownFiles = (id: string) => {
    const others = new Set([...Object.keys(stored.value), ...Object.keys(loading.value)].filter(other => other !== id).flatMap(files).map(file => file.path));
    return files(id).map(file => file.path).filter(path => !others.has(path));
  };

  const queue: string[] = [];
  let current: { id: string; controller: AbortController; ended: Promise<void> } | null = null;
  function load(id: string) {
    if (loading.value[id]) return;
    loading.value[id] = { status: 'waiting' };
    queue.push(id);
    void next();
  }
  async function next() {
    if (current || !queue.length || !catalogue.value) return;
    const id = queue.shift()!, controller = new AbortController(), wanted = files(id);
    let end = () => {};
    current = { id, controller, ended: new Promise(resolve => { end = resolve; }) };
    const total = wanted.reduce((sum, file) => sum + file.bytes, 0);
    loading.value[id] = { status: 'loading', progress: 0 };
    try {
      await navigator.storage?.persist?.();
      await download(wanted, catalogue.value.pieceBytes, done => { loading.value[id] = { status: 'loading', progress: done / total }; }, controller.signal);
      const kept = { id, bounds: entry(id)!.bounds, loadedAt: Date.now(), files: Object.fromEntries(wanted.map(file => [file.path, signature(file)])) };
      await keepStored(kept);
      stored.value[id] = kept;
    } catch (cause) {
      if (!controller.signal.aborted) error.value = `${area(id)?.name} ließ sich nicht laden: ${(cause as Error).message} Erneut „Laden“ macht dort weiter.`;
    } finally {
      delete loading.value[id];
      current = null;
      end();
      await measure();
      void next();
    }
  }
  // A stopped download leaves nothing behind that no other area needs.
  async function cancel(id: string) {
    const index = queue.indexOf(id);
    if (index >= 0) queue.splice(index, 1);
    const paths = ownFiles(id);
    if (current?.id === id) {
      current.controller.abort();
      await current.ended;
    }
    delete loading.value[id];
    if (!stored.value[id]) await removeFiles(paths);
    await measure();
  }
  async function remove(id: string) {
    await removeFiles(ownFiles(id));
    await forgetStored(id);
    delete stored.value[id];
    await measure();
  }
  // Newer files replace the changed ones; the rest stays.
  async function update(id: string) {
    const kept = stored.value[id];
    if (!kept) return;
    await removeFiles(files(id).filter(file => kept.files[file.path] !== signature(file)).map(file => file.path));
    load(id);
  }

  return { active, selected, outlines, states, free, error, areas, area, size, usedBytes, init, open, close, load, cancel, remove, update };
});

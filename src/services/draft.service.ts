import { watch } from 'vue';
import { hasDraftPoints, parseDraft, serializeDraft } from '../domain/route-draft.ts';
import type { RouteStore } from '../stores/route.store.ts';
import { transaction } from './database.service.ts';

const draftKey = 'current';
const legacyKey = 'richiroute.route-draft.v1';
const writers = new WeakMap<RouteStore, () => void>();

export function readDraft(): Promise<string | undefined> {
  return transaction('readonly', ['draft'], (tx, result) => {
    const request = tx.objectStore('draft').get(draftKey);
    request.onsuccess = () => result(request.result);
  });
}

export function writeDraft(payload: string): Promise<void> {
  return transaction('readwrite', ['draft'], tx => { tx.objectStore('draft').put(payload, draftKey); });
}

function readLegacyDraft(): string | undefined {
  try { return localStorage.getItem(legacyKey) ?? undefined; } catch { return undefined; }
}

// Moves a draft saved by earlier versions in localStorage to IndexedDB unchanged, even if it is invalid.
async function readStoredDraft(): Promise<string | undefined> {
  const saved = await readDraft();
  const legacy = saved === undefined ? readLegacyDraft() : undefined;
  if (legacy === undefined) return saved;
  await writeDraft(legacy);
  localStorage.removeItem(legacyKey);
  return legacy;
}

export function saveDraftNow(store: RouteStore) {
  writers.get(store)?.();
}

export function startDraftPersistence(store: RouteStore) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false, blocked = false, stopped = false;
  const channel = new BroadcastChannel('richiroute.route-draft');
  const fail = (message: string) => { store.draftStatus = 'error'; store.draftError = message; };

  async function load() {
    try {
      const saved = await readStoredDraft();
      if (stopped) return;
      dirty ||= hasDraftPoints(store.points);
      if (!dirty && saved !== undefined) {
        store.restoreDraft(parseDraft(saved));
        // The restored draft is already stored.
        dirty = false;
        clearTimeout(timer);
        if (!blocked) store.draftStatus = 'restored';
      }
    } catch {
      blocked = true;
      fail('Gespeicherte Route konnte nicht geladen werden. Der bisherige Entwurf wurde nicht überschrieben.');
    }
  }

  async function flush() {
    if (!dirty || blocked) return;
    dirty = false;
    try {
      await writeDraft(serializeDraft(store.points, store.legs));
      if (!stopped) channel.postMessage(null);
      if (!dirty && !blocked) {
        store.draftStatus = 'saved';
        store.draftError = null;
      }
    } catch {
      dirty = true;
      fail('Speichern im Browser fehlgeschlagen. Deine Änderungen sind noch nicht gesichert. Eine fertige Route kannst du als GPX herunterladen.');
    }
  }

  const stopWatch = watch([() => store.points, () => store.legs], () => {
    dirty = true;
    if (blocked) return;
    store.draftStatus = 'saving';
    clearTimeout(timer);
    timer = setTimeout(save, 200);
  }, { flush: 'sync' });
  // Writes run one at a time, after the initial load.
  let queue = load().then(flush);
  function save() {
    clearTimeout(timer);
    queue = queue.then(flush);
  }

  writers.set(store, () => { blocked = false; dirty = true; save(); });
  const onHide = () => { if (document.visibilityState === 'hidden') save(); };
  channel.onmessage = () => {
    blocked = true;
    fail('Der Entwurf wurde in einer anderen Registerkarte geändert. Automatisches Speichern ist hier pausiert. „Aktuelle Route hier speichern“ ersetzt den anderen Entwurf.');
  };
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', onHide);
  return () => {
    save();
    stopped = true;
    clearTimeout(timer);
    stopWatch();
    channel.close();
    writers.delete(store);
    window.removeEventListener('pagehide', save);
    document.removeEventListener('visibilitychange', onHide);
  };
}

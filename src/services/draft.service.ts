import { watch } from 'vue';
import { hasDraftPoints, parseDraft, serializeDraft } from '../domain/route-draft.ts';
import type { RouteStore } from '../stores/route.store.ts';

const draftKey = 'richiroute.route-draft.v1';
const writers = new WeakMap<RouteStore, () => void>();

export function saveDraftNow(store: RouteStore) {
  writers.get(store)?.();
}

export function startDraftPersistence(store: RouteStore, getStorage = () => window.localStorage) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let blocked = false;
  try {
    if (!hasDraftPoints(store.points)) {
      const saved = getStorage().getItem(draftKey);
      if (saved !== null) {
        store.restoreDraft(parseDraft(saved));
        store.draftStatus = 'restored';
      }
    } else {
      dirty = true;
    }
  } catch {
    blocked = true;
    store.draftStatus = 'error';
    store.draftError = 'Gespeicherte Route konnte nicht geladen werden. Der bisherige Entwurf wurde nicht überschrieben.';
  }

  function save() {
    if (!dirty || blocked) return;
    clearTimeout(timer);
    try {
      getStorage().setItem(draftKey, serializeDraft(store.points, store.legs));
      dirty = false;
      store.draftStatus = 'saved';
      store.draftError = null;
    } catch {
      store.draftStatus = 'error';
      store.draftError = 'Speichern im Browser fehlgeschlagen. Deine Änderungen sind noch nicht gesichert. Eine fertige Route kannst du als GPX herunterladen.';
    }
  }
  const stop = watch([() => store.points, () => store.legs], () => {
    dirty = true;
    if (blocked) return;
    store.draftStatus = 'saving';
    clearTimeout(timer);
    timer = setTimeout(save, 200);
  }, { flush: 'sync' });
  writers.set(store, () => { blocked = false; dirty = true; save(); });
  const onHide = () => { if (document.visibilityState === 'hidden') save(); };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== draftKey && event.key !== null) return;
    blocked = true;
    store.draftStatus = 'error';
    store.draftError = 'Der Entwurf wurde in einer anderen Registerkarte geändert. Automatisches Speichern ist hier pausiert. „Aktuelle Route hier speichern“ ersetzt den anderen Entwurf.';
  };
  window.addEventListener('pagehide', save);
  window.addEventListener('storage', onStorage);
  document.addEventListener('visibilitychange', onHide);
  if (dirty) save();
  return () => {
    save();
    clearTimeout(timer);
    stop();
    writers.delete(store);
    window.removeEventListener('pagehide', save);
    window.removeEventListener('storage', onStorage);
    document.removeEventListener('visibilitychange', onHide);
  };
}

import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { hasDraftPoints, parseDraft, serializeDraft } from '../domain/route-draft.ts';
import type { Coord } from '../domain/route-model.ts';
import type { GpxTrack } from '../domain/gpx-track.ts';
import { exportRouteBackup, importRouteBackup, type SavedRouteSummary } from '../domain/saved-route.ts';
import { routeLibrary } from '../services/route-library.service.ts';
import { useRouteStore } from '../stores/route.store.ts';

export function useRouteLibrary() {
  const store = useRouteStore();
  const entries = shallowRef<SavedRouteSummary[]>([]);
  const active = shallowRef<SavedRouteSummary>();
  const name = ref('');
  const busy = ref(false);
  const error = ref('');
  const message = ref('');
  const hasDraft = computed(() => hasDraftPoints(store.points));
  let activePayload = '';
  let channel: BroadcastChannel | undefined;
  let refreshId = 0;

  const payload = () => serializeDraft(store.points, store.legs);
  async function refresh() {
    const id = ++refreshId;
    const list = await routeLibrary.list();
    if (id === refreshId) entries.value = list;
  }
  async function run(action: () => Promise<void>) {
    if (busy.value) return;
    busy.value = true;
    error.value = '';
    message.value = '';
    try { await action(); }
    catch (cause) {
      error.value = cause instanceof DOMException && cause.name === 'QuotaExceededError'
        ? 'Der Browserspeicher ist voll. Bitte eine Sicherungsdatei herunterladen; die aktuelle Route bleibt geöffnet.'
        : cause instanceof Error ? cause.message : 'Der Routenspeicher ist nicht verfügbar.';
    } finally { busy.value = false; }
  }
  async function changed() {
    channel?.postMessage('changed');
    await refresh();
  }

  async function save(asCopy = false) {
    await run(async () => {
      const points = store.points, legs = store.legs;
      const snapshot = payload();
      active.value = await routeLibrary.save(name.value, snapshot, asCopy ? undefined : active.value);
      activePayload = snapshot;
      name.value = active.value.name;
      message.value = points === store.points && legs === store.legs
        ? `„${name.value}“ gespeichert.`
        : `Momentaufnahme von „${name.value}“ gespeichert. Neuere Änderungen sind noch offen.`;
      await changed();
    });
  }

  async function protectDraft() {
    if (!hasDraft.value) return;
    const points = store.points, legs = store.legs;
    const snapshot = payload();
    const alreadySaved = snapshot === activePayload && active.value && await routeLibrary.isCurrent(active.value);
    if (!alreadySaved) {
      await routeLibrary.save(`Entwurf · ${new Date().toLocaleString('de-AT')}`, snapshot);
      await changed();
    }
    if (points !== store.points || legs !== store.legs) {
      throw new Error('Die aktuelle Route hat sich während des Speicherns geändert. Bitte den Wechsel erneut ausführen.');
    }
    if (!alreadySaved) message.value = 'Bisherige Route in „Meine Routen“ gesichert.';
  }

  async function open(entry: SavedRouteSummary) {
    await run(async () => {
      const saved = await routeLibrary.read(entry.id);
      let draft;
      try { draft = parseDraft(saved.payload); }
      catch { throw new Error('Die gespeicherte Route ist beschädigt. Der aktuelle Entwurf bleibt geöffnet.'); }
      await protectDraft();
      activePayload = serializeDraft(draft.points, draft.legs);
      store.restoreDraft(draft);
      active.value = saved.summary;
      name.value = saved.summary.name;
      message.value = `„${name.value}“ geöffnet. ${message.value}`;
    });
  }

  async function newRoute(coords: Coord[] = [], shapeIndices: readonly number[] = []) {
    await run(async () => {
      await protectDraft();
      store.resetRoute(coords, shapeIndices);
      active.value = undefined;
      activePayload = '';
      name.value = '';
    });
  }

  // The track replaces the current route, which is saved first; saving the new route suggests the track's name.
  async function openTrack(track: GpxTrack) {
    await run(async () => {
      await protectDraft();
      store.importTrack(track);
      active.value = undefined;
      activePayload = '';
      name.value = track.name;
    });
  }

  async function rename(entry: SavedRouteSummary, value: string) {
    await run(async () => {
      const updated = await routeLibrary.rename(entry, value);
      if (active.value?.id === entry.id && active.value.revision === entry.revision) {
        active.value = updated;
        name.value = updated.name;
      }
      message.value = 'Routenname geändert.';
      await changed();
    });
  }

  async function duplicate(entry: SavedRouteSummary) {
    await run(async () => {
      const saved = await routeLibrary.read(entry.id);
      await routeLibrary.save(`${saved.summary.name.slice(0, 112)} (Kopie)`, saved.payload);
      message.value = 'Kopie gespeichert.';
      await changed();
    });
  }

  async function remove(entry: SavedRouteSummary) {
    await run(async () => {
      await routeLibrary.remove(entry);
      if (active.value?.id === entry.id) { active.value = undefined; activePayload = ''; }
      message.value = 'Gespeicherte Route gelöscht. Die geöffnete Route bleibt erhalten.';
      await changed();
    });
  }

  async function importFile(file: File) {
    await run(async () => {
      if (file.size > 64 * 1024 * 1024) throw new Error('Die Sicherungsdatei darf höchstens 64 MB groß sein.');
      let backup;
      try { backup = importRouteBackup(await file.text()); }
      catch { throw new Error('Ungültige oder nicht unterstützte RichiRoute-Sicherung. Es wurde keine Route verändert.'); }
      await routeLibrary.save(backup.name, backup.payload);
      message.value = `„${backup.name}“ importiert. Zum Bearbeiten in der Liste öffnen.`;
      await changed();
    });
  }

  async function download() {
    await run(async () => {
      const contents = exportRouteBackup(name.value.trim() || 'Meine Route', payload());
      const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `richiroute-${new Date().toISOString().slice(0, 10)}.richiroute.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message.value = 'Sicherung der aktuellen Route heruntergeladen.';
    });
  }

  const refreshList = () => { void run(refresh); };
  onMounted(() => {
    refreshList();
    window.addEventListener('focus', refreshList);
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('richiroute.routes');
      channel.onmessage = refreshList;
    }
  });
  onBeforeUnmount(() => { window.removeEventListener('focus', refreshList); channel?.close(); });

  return { entries, active, name, busy, error, message, hasDraft, save, open, openTrack, newRoute, rename, duplicate, remove,
    importFile, download, refreshList };
}

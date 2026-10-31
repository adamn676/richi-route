import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { hasDraftPoints, parseDraft, serializeDraft } from '../domain/route-draft.ts';
import type { RoutePoint } from '../domain/route-model.ts';
import { gpxMaxBytes, gpxTooLarge } from '../domain/gpx-import.ts';
import { exportRouteBackup, importRouteBackup, routeSummary, routeTitle, type SavedRouteSummary } from '../domain/saved-route.ts';
import { routeLibrary } from '../services/route-library.service.ts';
import { recentRoutes } from '../services/recent-routes.service.ts';
import { gpxSections } from '../domain/gpx-route.ts';
import { readGpx } from '../services/gpx-import.service.ts';
import { useRouteStore } from '../stores/route.store.ts';
import { useLoopSuggestionsStore } from '../stores/loop-suggestions.store.ts';

export function useRouteLibrary() {
  const store = useRouteStore();
  const loops = useLoopSuggestionsStore();
  const entries = shallowRef<SavedRouteSummary[]>([]);
  const recent = shallowRef<SavedRouteSummary[]>([]);
  // The route the last switch put aside, which the confirmation offers to bring back.
  const restorable = shallowRef<SavedRouteSummary>();
  const active = shallowRef<SavedRouteSummary>();
  const name = ref('');
  const busy = ref(false);
  const error = ref('');
  const message = ref('');
  const hasDraft = computed(() => hasDraftPoints(store.points));
  // The name the route is kept under: the one typed, otherwise where it goes.
  const title = computed(() => (name.value.trim() || routeTitle(store.waypoints) || 'Neue Route').slice(0, 120));
  let activePayload = '';
  let channel: BroadcastChannel | undefined;
  let refreshId = 0;
  const reader = shallowRef<AbortController>();
  const reading = computed(() => Boolean(reader.value));

  const payload = () => serializeDraft(store.points, store.legs);
  // Street names filled in after opening (a stop saved without one, still in its place) are no change of the route.
  function unchanged(snapshot: string) {
    if (snapshot === activePayload) return true;
    if (!activePayload) return false;
    const saved = new Map(parseDraft(activePayload).points.map(point => [point.id, point]));
    const points = store.points.map((point): RoutePoint => {
      const before = saved.get(point.id);
      return point.type === 'stop' && before?.type === 'stop' && before.address === null && !before.userInput &&
        point.address !== null && point.address === point.userInput && String(point.coord) === String(before.coord)
        ? { ...point, address: null, userInput: '' } : point;
    });
    return serializeDraft(points, store.legs) === activePayload;
  }
  // Whether the route differs from its saved entry: a change shows at once, a way back to the saved state shortly after.
  const edited = ref(false);
  let savedState = { points: store.points, legs: store.legs };
  function mark(points = store.points, legs = store.legs) {
    savedState = { points, legs };
    edited.value = points !== store.points || legs !== store.legs;
  }
  let check: ReturnType<typeof setTimeout> | undefined;
  watch([() => store.points, () => store.legs], ([points, legs]) => {
    if (points === savedState.points && legs === savedState.legs) return;
    edited.value = true;
    clearTimeout(check);
    if (active.value) check = setTimeout(() => { edited.value = !unchanged(payload()); }, 300);
  });
  // One list failing leaves the other.
  async function refresh() {
    const id = ++refreshId;
    const [list, kept] = await Promise.allSettled([routeLibrary.list(), recentRoutes.list()]);
    if (id !== refreshId) return;
    if (list.status === 'fulfilled') entries.value = list.value;
    if (kept.status === 'fulfilled') recent.value = kept.value;
    const failed = [list, kept].find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  function describe(cause: unknown) {
    return cause instanceof DOMException && cause.name === 'QuotaExceededError'
      ? 'Der Browserspeicher ist voll. Bitte die Route als RichiRoute-Datei herunterladen; die aktuelle Route bleibt geöffnet.'
      : cause instanceof Error ? cause.message : 'Der Routenspeicher ist nicht verfügbar.';
  }
  async function run(action: () => Promise<void>): Promise<boolean> {
    if (busy.value) return false;
    busy.value = true;
    error.value = '';
    message.value = '';
    restorable.value = undefined;
    try { await action(); }
    catch (cause) {
      error.value = describe(cause);
      // A failure can come from another tab's change; the lists show what is stored now.
      void refresh().catch(() => {});
    }
    finally { busy.value = false; }
    return !error.value;
  }
  async function changed() {
    channel?.postMessage('changed');
    await refresh();
  }

  async function save() {
    await run(async () => {
      const points = store.points, legs = store.legs;
      const snapshot = payload();
      active.value = await routeLibrary.save(title.value, snapshot, active.value);
      activePayload = snapshot;
      mark(points, legs);
      name.value = active.value.name;
      message.value = points === store.points && legs === store.legs
        ? `„${name.value}“ gespeichert.`
        : `Momentaufnahme von „${name.value}“ gespeichert. Neuere Änderungen sind noch offen.`;
      await changed();
    });
  }

  // A route replaced without being saved goes to the recently edited ones. Only a route worth keeping: one with a start
  // and a destination, and not a suggested loop being looked at, which the same request brings back.
  // leaving: a recently edited route being opened, which leaves them in the same step.
  async function keepCurrent(leaving?: string) {
    if (!store.route || loops.selected !== null) return false;
    const points = store.points, legs = store.legs;
    const snapshot = payload();
    if (unchanged(snapshot) && active.value && await routeLibrary.isCurrent(active.value)) return false;
    const kept = await recentRoutes.add(routeSummary(title.value, { version: 1, points, legs }), snapshot, leaving);
    if (points !== store.points || legs !== store.legs) {
      throw new Error('Die aktuelle Route hat sich während des Wechsels geändert. Bitte den Wechsel erneut ausführen.');
    }
    restorable.value = kept;
    message.value = 'Vorige Route liegt in „Zuletzt bearbeitet“.';
    return true;
  }

  // The route now current: a saved one by its summary and stored form, otherwise an unsaved one under a name.
  function current(title: string, saved?: SavedRouteSummary, savedPayload = '') {
    active.value = saved;
    activePayload = savedPayload;
    name.value = title;
    mark();
  }

  // A stored route in place of the current one, which goes to the recently edited ones.
  async function show(stored: string, title: string, saved?: SavedRouteSummary, leaving?: string) {
    let draft;
    try { draft = parseDraft(stored); }
    catch { throw new Error('Die gespeicherte Route ist beschädigt. Die aktuelle Route bleibt geöffnet.'); }
    if (!await keepCurrent(leaving) && leaving) await recentRoutes.remove(leaving);
    store.restoreDraft(draft);
    // Restoring the draft on start keeps the view; an opened route is shown.
    store.fitRequest++;
    current(title, saved, saved && serializeDraft(draft.points, draft.legs));
    // The route shows at once; where the one before went is the news, with the offer to bring it back.
    message.value ||= `„${title}“ geöffnet.`;
  }

  function open(entry: SavedRouteSummary) {
    return run(async () => {
      const saved = await routeLibrary.read(entry.id);
      await show(saved.payload, saved.summary.name, saved.summary);
      await changed();
    });
  }

  function newRoute() {
    return run(async () => {
      await keepCurrent();
      store.resetRoute();
      current('');
      await changed();
    });
  }

  // A recently edited route opened again leaves the list: it is the current route now.
  function openRecent(entry: SavedRouteSummary) {
    return run(async () => {
      await show(await recentRoutes.read(entry.id), entry.name, undefined, entry.id);
      await changed();
    });
  }

  async function saveRecent(entry: SavedRouteSummary) {
    await run(async () => {
      await routeLibrary.save(entry.name, await recentRoutes.read(entry.id));
      await recentRoutes.remove(entry.id);
      message.value = `„${entry.name}“ in „Meine Routen“ gespeichert.`;
      await changed();
    });
  }

  // A GPX file replaces the current route with its exact track; saving it suggests the track's name.
  async function openGpx(file: File) {
    if (busy.value) return false;
    const { signal } = reader.value = new AbortController();
    try {
      const opened = await run(async () => {
        if (file.size > gpxMaxBytes) throw new Error(gpxTooLarge);
        const bytes = await file.arrayBuffer();
        signal.throwIfAborted();
        const track = await readGpx(bytes, file.name, signal);
        // Checked before the current route is put aside.
        const sections = gpxSections(track);
        if (!sections.length) throw new Error('Die GPX-Datei enthält keinen Streckenverlauf.');
        await keepCurrent();
        store.importTrack(track, sections);
        current(track.name);
        await changed();
      });
      // Cancelling is no error.
      if (signal.aborted) error.value = '';
      return opened;
    } finally { reader.value = undefined; }
  }
  const cancelGpx = () => reader.value?.abort();

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

  // A RichiRoute file opens as the route, as a GPX file does; saving it keeps it in this browser.
  function openFile(file: File) {
    return run(async () => {
      if (file.size > 64 * 1024 * 1024) throw new Error('Die RichiRoute-Datei darf höchstens 64 MB groß sein.');
      let backup;
      try { backup = importRouteBackup(await file.text()); }
      catch { throw new Error('Ungültige oder nicht unterstützte RichiRoute-Datei. Die aktuelle Route bleibt geöffnet.'); }
      await show(backup.payload, backup.name);
      await changed();
    });
  }

  async function download() {
    await run(async () => {
      const contents = exportRouteBackup(title.value, payload());
      const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `richiroute-${new Date().toISOString().slice(0, 10)}.richiroute.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message.value = 'RichiRoute-Datei heruntergeladen.';
    });
  }

  // Refreshing (on focus, or when another tab changed the routes) runs beside the actions and keeps their messages.
  const refreshing = ref(false);
  async function refreshList() {
    refreshing.value = true;
    try { await refresh(); }
    catch (cause) { error.value = describe(cause); }
    finally { refreshing.value = false; }
  }
  onMounted(() => {
    refreshList();
    window.addEventListener('focus', refreshList);
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('richiroute.routes');
      channel.onmessage = refreshList;
    }
  });
  onBeforeUnmount(() => { window.removeEventListener('focus', refreshList); channel?.close(); clearTimeout(check); });

  return { entries, recent, active, name, title, edited, busy, refreshing, error, message, restorable, reading, hasDraft, save, open, openRecent, saveRecent,
    openGpx, cancelGpx, newRoute, rename, duplicate, remove, openFile, download };
}

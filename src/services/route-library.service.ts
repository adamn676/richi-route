import { parseDraft } from '../domain/route-draft.ts';
import { routeName, routeSummary, type SavedRouteSummary } from '../domain/saved-route.ts';
import { transaction } from './database.service.ts';

const conflictMessage = 'Diese Route wurde inzwischen geändert oder gelöscht. Bitte die Liste aktualisieren und erneut versuchen.';

function requireRevision(actual: SavedRouteSummary | undefined, expected: SavedRouteSummary): SavedRouteSummary {
  if (!actual || actual.revision !== expected.revision) throw new Error(conflictMessage);
  return actual;
}

async function changeRoute<T>(expected: SavedRouteSummary, change: (tx: IDBTransaction, current: SavedRouteSummary) => T): Promise<T> {
  return transaction('readwrite', ['summaries', 'payloads'], (tx, result, fail) => {
    const request = tx.objectStore('summaries').get(expected.id);
    request.onsuccess = () => {
      try { result(change(tx, requireRevision(request.result, expected))); }
      catch (cause) { fail(cause instanceof Error ? cause : new Error(conflictMessage)); }
    };
  });
}

export const routeLibrary = {
  async isCurrent(expected: SavedRouteSummary): Promise<boolean> {
    return transaction('readonly', ['summaries'], (tx, result) => {
      const request = tx.objectStore('summaries').get(expected.id);
      request.onsuccess = () => result(request.result?.revision === expected.revision);
    });
  },

  async list(): Promise<SavedRouteSummary[]> {
    const summaries = await transaction<SavedRouteSummary[]>('readonly', ['summaries'], (tx, result) => {
      const request = tx.objectStore('summaries').getAll();
      request.onsuccess = () => result(request.result);
    });
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  },

  async read(id: string): Promise<{ summary: SavedRouteSummary; payload: string }> {
    return transaction('readonly', ['summaries', 'payloads'], (tx, result, fail) => {
      const summary = tx.objectStore('summaries').get(id);
      const payload = tx.objectStore('payloads').get(id);
      payload.onsuccess = () => {
        if (!summary.result || typeof payload.result !== 'string') {
          fail(new Error('Diese Route ist nicht mehr verfügbar. Bitte die Liste aktualisieren.'));
        } else result({ summary: summary.result, payload: payload.result });
      };
    });
  },

  async save(name: string, payload: string, expected?: SavedRouteSummary): Promise<SavedRouteSummary> {
    const summary = routeSummary(name, parseDraft(payload));
    if (expected) return changeRoute(expected, (tx, current) => {
      const updated = { ...summary, id: current.id, createdAt: current.createdAt };
      tx.objectStore('summaries').put(updated);
      tx.objectStore('payloads').put(payload, updated.id);
      return updated;
    });
    return transaction('readwrite', ['summaries', 'payloads'], (tx, result) => {
      tx.objectStore('summaries').add(summary);
      tx.objectStore('payloads').add(payload, summary.id);
      result(summary);
    });
  },

  async rename(expected: SavedRouteSummary, name: string): Promise<SavedRouteSummary> {
    const validName = routeName(name);
    return changeRoute(expected, (tx, current) => {
      const updated = { ...current, name: validName, revision: crypto.randomUUID(), updatedAt: new Date().toISOString() };
      tx.objectStore('summaries').put(updated);
      return updated;
    });
  },

  async remove(expected: SavedRouteSummary): Promise<void> {
    return changeRoute(expected, tx => {
      tx.objectStore('summaries').delete(expected.id);
      tx.objectStore('payloads').delete(expected.id);
    });
  },
};

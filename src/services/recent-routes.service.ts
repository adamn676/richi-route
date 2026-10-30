import type { SavedRouteSummary } from '../domain/saved-route.ts';
import { transaction } from './database.service.ts';

// Routes replaced without being saved: the last three, for seven days.
export const recentLimit = 3;
export const recentDays = 7;

const stores = ['recentSummaries', 'recentPayloads'];

// The newest within the limits.
function current(summaries: SavedRouteSummary[]): SavedRouteSummary[] {
  const oldest = new Date(Date.now() - recentDays * 86400000).toISOString();
  return summaries.filter(summary => summary.updatedAt >= oldest)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, recentLimit);
}

export const recentRoutes = {
  async list(): Promise<SavedRouteSummary[]> {
    return transaction('readonly', ['recentSummaries'], (tx, result, _fail, guard) => {
      const request = tx.objectStore('recentSummaries').getAll();
      request.onsuccess = guard(() => result(current(request.result)));
    });
  },

  // Adding keeps the store within the limits; leaving names a route that leaves the list at the same time.
  async add(summary: SavedRouteSummary, payload: string, leaving?: string): Promise<SavedRouteSummary> {
    return transaction('readwrite', stores, (tx, result, _fail, guard) => {
      const summaries = tx.objectStore('recentSummaries'), payloads = tx.objectStore('recentPayloads');
      const request = summaries.getAll();
      request.onsuccess = guard(() => {
        const others = request.result as SavedRouteSummary[];
        // The same route kept again moves to the top instead of showing twice. Only one as long and with as many
        // points can be it, so no other route is read.
        const alike = others.filter(other => other.distanceMeters === summary.distanceMeters && other.pointCount === summary.pointCount);
        const gone = new Set(leaving ? [leaving] : []);
        let waiting = alike.length;
        const keep = guard(() => {
          summaries.put(summary);
          payloads.put(payload, summary.id);
          const kept = current([summary, ...others.filter(other => !gone.has(other.id))]);
          for (const other of others) if (!kept.includes(other)) { summaries.delete(other.id); payloads.delete(other.id); }
          result(summary);
        });
        for (const other of alike) {
          const read = payloads.get(other.id);
          read.onsuccess = guard(() => {
            if (read.result === payload) gone.add(other.id);
            if (!--waiting) keep();
          });
        }
        if (!waiting) keep();
      });
    });
  },

  async read(id: string): Promise<string> {
    return transaction('readonly', ['recentPayloads'], (tx, result, fail) => {
      const request = tx.objectStore('recentPayloads').get(id);
      request.onsuccess = () => {
        if (typeof request.result === 'string') result(request.result);
        else fail(new Error(`Diese Route ist nicht mehr verfügbar. Nicht gespeicherte Routen bleiben ${recentDays} Tage.`));
      };
    });
  },

  async remove(id: string): Promise<void> {
    return transaction('readwrite', stores, tx => {
      tx.objectStore('recentSummaries').delete(id);
      tx.objectStore('recentPayloads').delete(id);
    });
  },
};

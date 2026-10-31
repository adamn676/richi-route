import searchModule from '@/assets/search.wasm?url';
import type { Coord } from '../domain/route-model.ts';
import { storedFile } from './offline-files';
import { startOfflineSearch, type OfflineSearch } from './offline-search';
import { useDeviceSearch } from './geocoding.service';
import { covers, deviceAreas, onDeviceChange } from './offline-storage';

// The address search of the offline areas on the device, asked as the search server is ("/api/?q=…", "/reverse?…").
// Each area's index starts on first use; a forward search asks all of them, the one around the map's centre first, a
// reverse search the ones holding the point.
// The search program is fetched as soon as an area is on the device, while there is a network.
let module: Promise<ArrayBuffer> | undefined;
const searches = new Map<string, Promise<OfflineSearch | null>>();
onDeviceChange(() => {
  searches.clear();
  if (deviceAreas().length) module ??= fetch(searchModule).then(response => response.arrayBuffer());
  module?.catch(() => { module = undefined; });
});
function searchOf(id: string) {
  if (!searches.has(id)) {
    module ??= fetch(searchModule).then(response => response.arrayBuffer());
    searches.set(id, storedFile(`areas/${id}/search.index`).then(async file =>
      file && startOfflineSearch(await module!, new Uint8Array(await file.arrayBuffer()))).catch(() => null));
  }
  return searches.get(id)!;
}

// The features found, or null without an area on the device that could answer.
async function askOffline(request: string, point: Coord | null, reverse: boolean): Promise<unknown[] | null> {
  const areas = deviceAreas().filter(area => !reverse || (point && covers(area.bounds, point)))
    .sort((a, b) => Number(Boolean(point && covers(b.bounds, point))) - Number(Boolean(point && covers(a.bounds, point))));
  if (!areas.length) return null;
  const seen = new Set<string>(), features: unknown[] = [];
  for (const area of areas) {
    const answer = (await searchOf(area.id))?.ask(request) as { features?: { geometry?: { coordinates?: unknown }; properties?: { name?: unknown } }[] } | null;
    for (const feature of answer?.features ?? []) {
      const key = JSON.stringify([feature.properties?.name, feature.geometry?.coordinates]);
      if (!seen.has(key)) { seen.add(key); features.push(feature); }
    }
  }
  return features.slice(0, Number(new URLSearchParams(request.split('?')[1]).get('limit')) || undefined);
}
useDeviceSearch(askOffline);

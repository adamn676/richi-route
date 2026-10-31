import { addProtocol } from 'maplibre-gl';
import { FileSource, PMTiles } from 'pmtiles';
import { storedFile } from './offline-files';
import { deviceAreas, onDeviceChange, overlaps, type Bounds } from './offline-storage';

// The street map's and the relief's tiles from the offline areas on the device where one covers them, else from the
// map service. The map's sources ask for "richi://map/{z}/{x}/{y}" and "richi://terrain/{z}/{x}/{y}".
export type TileKind = 'map' | 'terrain';
export const offlineTiles = (kind: TileKind) => `richi://${kind}/{z}/{x}/{y}`;
// The relief's tiles and deepest zoom (scripts/start-maps.mjs, .cache/maps/terrain.pmtiles).
export const terrainTiles = { url: '/maps/terrain/{z}/{x}/{y}.webp', maxzoom: 10 };
const network: Record<TileKind, string> = { map: '', terrain: terrainTiles.url };
export const setNetworkTiles = (kind: TileKind, template: string) => { network[kind] = template; };

// The device's archives open on first use, and again after a change.
const archives = new Map<string, Promise<PMTiles | null>>();
onDeviceChange(() => archives.clear());
function archive(path: string) {
  if (!archives.has(path)) archives.set(path, storedFile(path).then(file => file && new PMTiles(new FileSource(file))).catch(() => null));
  return archives.get(path)!;
}
function tileBounds(z: number, x: number, y: number): Bounds {
  const lon = (x: number) => x / 2 ** z * 360 - 180;
  const lat = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

addProtocol('richi', async ({ url }, controller) => {
  const [, kind, ...zxy] = /^richi:\/\/(map|terrain)\/(\d+)\/(\d+)\/(\d+)$/.exec(url) ?? [];
  if (!kind) throw new Error(`Unknown tile ${url}`);
  const [z, x, y] = zxy.map(Number), bounds = tileBounds(z, x, y);
  for (const area of deviceAreas()) {
    if (!overlaps(area.bounds, bounds)) continue;
    const tile = await (await archive(`areas/${area.id}/${kind}.pmtiles`))?.getZxy(z, x, y, controller.signal).catch(() => undefined);
    if (tile) return { data: tile.data };
  }
  const source = network[kind as TileKind].replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { data: await response.arrayBuffer() };
  } catch (error) {
    // Offline beyond the areas on the device, the map stays empty there instead of reporting each tile.
    if (!navigator.onLine && kind === 'map') return { data: new ArrayBuffer(0) };
    throw error;
  }
});

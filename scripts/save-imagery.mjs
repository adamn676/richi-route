import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { mkdir, rename, stat, statfs } from 'node:fs/promises';
import { Database } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import config from './imagery.json' with { type: 'json' };
import { regionTiles } from './imagery/regions.mjs';

const { values } = parseArgs({ options: {
  name: { type: 'string' }, bbox: { type: 'string' }, gpx: { type: 'string' },
  maxzoom: { type: 'string', default: '16' }, 'buffer-km': { type: 'string', default: '1' },
} });
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(values.name ?? '') || Boolean(values.bbox) === Boolean(values.gpx)) {
  throw new Error('Use --name area-name with either --bbox west,south,east,north or --gpx route.gpx. Optional: --maxzoom 16 --buffer-km 1.');
}
let tracks, bounds;
if (values.gpx) {
  if ((await stat(values.gpx)).size > 20 * 1024 ** 2) throw new Error('GPX must be smaller than 20 MiB.');
  const result = spawnSync('python3', ['-c', `import json, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
tracks = []
for segment in root.iter():
    if segment.tag.split('}')[-1] in ('trkseg', 'rte'):
        points = [[float(p.attrib['lon']), float(p.attrib['lat'])] for p in segment if p.tag.split('}')[-1] in ('trkpt', 'rtept')]
        if points: tracks.append(points)
print(json.dumps(tracks))`, values.gpx], { encoding: 'utf8', maxBuffer: 20 * 1024 ** 2 });
  if (result.error || result.status !== 0) throw new Error('Could not read GPX tracks.', { cause: result.error ?? result.stderr });
  tracks = JSON.parse(result.stdout);
  const points = tracks.flat();
  if (!points.length || points.some(p => p.length !== 2 || !p.every(Number.isFinite))) throw new Error('GPX has no valid track or route.');
  bounds = points.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [180, 90, -180, -90]);
  // A straight north/south or east/west track still has a corridor.
  if (bounds[0] === bounds[2]) { bounds[0] -= .00001; bounds[2] += .00001; }
  if (bounds[1] === bounds[3]) { bounds[1] -= .00001; bounds[3] += .00001; }
} else bounds = values.bbox.split(',').map(Number);
const tiles = regionTiles(bounds, Number(values.maxzoom), tracks, Number(values['buffer-km']));
const directory = fileURLToPath(new URL('../.cache/imagery/regions/', import.meta.url));
await mkdir(directory, { recursive: true });
const target = path.join(directory, values.name + '.mbtiles');
try { await stat(target); throw new Error('This saved area already exists. Choose another name.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const staging = target + '.part';
const db = new Database(staging);
db.exec(`CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB,
  PRIMARY KEY (zoom_level, tile_column, tile_row));`);
const metadata = db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)');
const sourceRevision = createHash('sha256').update(JSON.stringify(config)).digest('hex');
const selection = JSON.stringify({ bounds, maxzoom: values.maxzoom, tracks, buffer: values['buffer-km'], revision: sourceRevision });
const previous = db.prepare("SELECT value FROM metadata WHERE name = 'selection'").get()?.value;
if (previous && previous !== selection) { db.close(); throw new Error('An interrupted download with this name has different settings. Choose another name.'); }
metadata.run('selection', selection);
const exists = db.prepare('SELECT 1 FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?');
const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
let next = 0, completed = 0, failure;
const origin = `http://127.0.0.1:${process.env.MAPS_PORT ?? 8088}`;
console.log(`Saving ${tiles.length} tiles to ${target}. Interrupted downloads can be resumed.`);
async function downloadTile(z, x, y) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${origin}/imagery/${z}/${x}/${y}.jpg`, { signal: AbortSignal.timeout(90000) });
      if (!response.ok || response.headers.get('X-Imagery-Degraded') !== '0') {
        await response.body?.cancel();
        throw new Error(`Tile ${z}/${x}/${y} is unavailable or incomplete. Retry when online.`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 2) throw error;
      await delay(500 * 2 ** attempt);
    }
  }
}
async function download() {
  while (!failure && next < tiles.length) {
    const [z, x, y] = tiles[next++], row = 2 ** z - 1 - y;
    try {
      if (!exists.get(z, x, row)) {
        const space = await statfs(directory);
        if (space.bavail * space.bsize < config.reserveBytes + 16 * 1024 ** 2) throw new Error('Stopping before disk space falls below 15 GiB.');
        insert.run(z, x, row, await downloadTile(z, x, y));
      }
      completed++;
      if (completed % 25 === 0 || completed === tiles.length) console.log(`${completed}/${tiles.length}`);
    } catch (error) { failure = error; }
  }
}
try {
  await Promise.all([download(), download()]);
  if (failure) throw failure;
  const info = await fetch(`${origin}/imagery.json`).then(response => response.json());
  for (const [key, value] of Object.entries({ name: values.name, format: 'jpg', type: 'baselayer', version: '1.3',
    bounds: bounds.join(','), minzoom: '9', maxzoom: values.maxzoom, attribution: info.attribution,
    description: 'Saved European imagery', created: new Date().toISOString(), revision: config.revision, sourceRevision })) metadata.run(key, value);
} finally { db.close(); }
await rename(staging, target);
console.log('Saved. Restart the map service to load the area. Saved areas are excluded from cache eviction.');

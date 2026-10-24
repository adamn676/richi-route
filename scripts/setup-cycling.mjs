import { Database } from 'node:sqlite';
import { mkdir, readFile, rename, rm, statfs } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cyclingPoint } from './cycling/points.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.cache/cycling');
await mkdir(directory, { recursive: true });
const space = await statfs(directory);
if (space.bavail * space.bsize < 16 * 1024 ** 3) throw new Error('Cycling setup needs 1 GiB above the 15 GiB reserve.');
const fileIndex = process.argv.indexOf('--file');
let data;
if (fileIndex !== -1) {
  data = JSON.parse(await readFile(process.argv[fileIndex + 1], 'utf8'));
} else {
  const query = '[out:json][timeout:240][maxsize:536870912][bbox:34,-25,72,45];'
    + '(nwr[amenity=drinking_water];nwr[drinking_water=yes];nwr[amenity=bicycle_repair_station];nwr[shop=bicycle];nwr[railway~"^(station|halt)$"];);out center tags;';
  console.log('Downloading European drinking-water and bicycle-service points.');
  const response = await fetch(process.env.RICHIROUTE_OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter', {
    method: 'POST', body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(270000),
    headers: { 'User-Agent': 'RichiRoute/1.0 (local cycling POI dataset setup)' },
  });
  if (!response.ok) throw new Error(`Cycling data download: HTTP ${response.status}`);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 128 * 1024 ** 2) throw new Error('Cycling download exceeds 128 MiB.');
    chunks.push(chunk);
  }
  data = JSON.parse(Buffer.concat(chunks).toString());
}
if (data.remark || !Array.isArray(data.elements) || !data.osm3s?.timestamp_osm_base) {
  throw new Error(data.remark ?? 'Incomplete cycling dataset');
}
const partial = path.join(directory, 'points.sqlite.part');
await rm(partial, { force: true });
const db = new Database(partial);
let count = 0;
try {
  db.exec(`CREATE TABLE metadata (value TEXT NOT NULL);
    CREATE TABLE points (id INTEGER PRIMARY KEY, feature TEXT NOT NULL);
    CREATE VIRTUAL TABLE positions USING rtree(id, minlon, maxlon, minlat, maxlat);
    BEGIN;`);
  const insert = db.prepare('INSERT INTO points VALUES (?, ?)');
  const locate = db.prepare('INSERT INTO positions VALUES (?, ?, ?, ?, ?)');
  const seen = new Set();
  for (const element of data.elements) {
    const feature = cyclingPoint(element);
    if (!feature || seen.has(feature.id)) continue;
    const [lon, lat] = feature.geometry.coordinates;
    if (lon < -25 || lon > 45 || lat < 34 || lat > 72) continue;
    seen.add(feature.id);
    insert.run(++count, JSON.stringify(feature)); locate.run(count, lon, lon, lat, lat);
  }
  if (!count) throw new Error('Cycling dataset is empty; keeping the previous database.');
  db.prepare('INSERT INTO metadata VALUES (?)').run(JSON.stringify({ updated: data.osm3s.timestamp_osm_base, count,
    coverage: data.coverage ?? (fileIndex === -1 ? 'Europa' : 'Importierter Ausschnitt') }));
  db.exec('COMMIT;');
} finally { db.close(); }
await rename(partial, path.join(directory, 'points.sqlite'));
console.log(`Saved ${count.toLocaleString('en')} cycling points, OSM ${data.osm3s.timestamp_osm_base}. Restart maps:start to use them.`);

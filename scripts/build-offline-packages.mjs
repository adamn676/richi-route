// Builds what a phone downloads for each area in public/offline-areas.json, into .cache/offline/packages/:
//   areas/<id>/map.pmtiles, terrain.pmtiles   the map and relief tiles over the area (cut from the installed archives;
//                                             the map without land use the style never draws)
//   areas/<id>/search.index                   the address search over the area's bounds (search/)
//   areas/<id>/cycling.json                   water, repair stations, bike shops and stations (npm run cycling:setup)
//   routing/<square>.square                   the routing data, by one-degree square, shared between areas
//   catalogue.json                            areas, files, sizes, a SHA-256 per 8 MiB piece, and what rejoins the squares
//   node scripts/build-offline-packages.mjs [--area at-6,at-2] [--rebuild]
// Files already built are kept unless --rebuild.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { split, squareName } from './offline/rd5.mjs';
import { drawnKinds, rewrite, strip } from './offline/tiles.mjs';
import { openCyclingPoints } from './cycling/points.mjs';
import { inside } from './offline/geometry.mjs';
import catalogueSource from './offline-areas.json' with { type: 'json' };
import searchData from './search-data.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, '.cache/offline/packages');
const pmtiles = path.join(root, '.cache/tools/pmtiles/pmtiles');
const searchBinary = path.join(root, 'search/target/release/richi-search');
const downloads = path.join(root, '.cache/services/search/downloads');
const segments = path.join(root, '../richiroute-ubuntu-benchmark/data');
const option = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const rebuild = process.argv.includes('--rebuild');
// The land use the planner's map draws (scripts/start-maps.mjs uses the same layers).
const landuse = drawnKinds(layers('europe', namedFlavor('light'), { lang: 'de' }), 'landuse');
const cycling = openCyclingPoints(path.join(root, '.cache/cycling/points.sqlite'));

async function exists(file) {
  try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with ${code}`)));
  });
}
// The SHA-256 of each piece of a file, so a phone checks a download as it arrives and resumes after the last good piece.
const pieceBytes = 8 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function pieces(file) {
  const found = [];
  for await (const piece of createReadStream(file, { highWaterMark: pieceBytes })) found.push(digest(piece));
  return found;
}
const piecesOf = bytes => Array.from({ length: Math.ceil(bytes.length / pieceBytes) }, (_, i) => digest(bytes.subarray(i * pieceBytes, (i + 1) * pieceBytes)));
// Built beside its place and moved there when complete, so a stopped build leaves nothing half-written.
async function build(file, make) {
  if (!rebuild && await exists(file)) return;
  await rm(file + '.part', { force: true });
  await make(file + '.part');
  await rename(file + '.part', file);
}

const { features } = JSON.parse(await readFile(path.join(root, 'public/offline-areas.json'), 'utf8'));
const chosen = option('--area')?.split(',');
const areas = features.filter(feature => !chosen || chosen.includes(feature.properties.id));
if (chosen && areas.length !== chosen.length) throw new Error(`Unknown area among ${chosen.join(', ')}`);

const covers = (polygons, point) => polygons.some(([outer, ...holes]) => inside(point, outer) && !holes.some(hole => inside(point, hole)));
// The one-degree squares an area touches: one with a corner of the outline in it, or a point of a fine grid inside it.
function squaresOf(polygons) {
  const points = polygons.flat(2), found = new Set();
  const name = (west, south) => `${west < 0 ? 'W' : 'E'}${Math.abs(west)}_${south < 0 ? 'S' : 'N'}${Math.abs(south)}`;
  for (const [x, y] of points) found.add(name(Math.floor(x), Math.floor(y)));
  const [west, south, east, north] = bounds(polygons);
  for (let x = Math.floor(west); x < east; x++) {
    for (let y = Math.floor(south); y < north; y++) {
      for (let i = 0; i < 400 && !found.has(name(x, y)); i++) {
        if (covers(polygons, [x + (i % 20 + .5) / 20, y + (Math.floor(i / 20) + .5) / 20])) found.add(name(x, y));
      }
    }
  }
  return [...found].sort();
}
function bounds(polygons) {
  const points = polygons.flat(2);
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
}

// The routing data's squares, each written once.
await mkdir(path.join(target, 'routing'), { recursive: true });
const files = {}, squares = {};
// Squares only from routing data the local rules were reviewed against (as npm run routing:prepare checks).
const rules = JSON.parse(await readFile(path.join(root, 'config/routing-rules.json'), 'utf8')).rules.filter(rule => rule.enabled);
for (const file of (await readdir(segments)).filter(name => name.endsWith('.rd5')).sort()) {
  const bytes = new Uint8Array(await readFile(path.join(segments, file)));
  const reviewed = rules.filter(rule => file in rule.reviewedTiles);
  if (reviewed.some(rule => rule.reviewedTiles[file] !== digest(bytes))) {
    throw new Error(`Map data changed: ${file}. Review these local rules before updating their tile checksums: ${reviewed.map(rule => rule.id).join(', ')}`);
  }
  const parts = split(bytes);
  files[file] = { ...parts.header, created: String(parts.header.created) };
  for (const square of parts.squares) {
    const name = squareName(square.index, file), out = path.join(target, 'routing', `${name}.square`);
    await build(out, part => writeFile(part, square.bytes));
    squares[name] = { file, index: square.index, checksum: square.checksum, path: `routing/${name}.square`, bytes: square.bytes.length,
      pieces: piecesOf(square.bytes) };
  }
}

const extracts = new Map(searchData.extracts.map(extract => [extract.region, extract.country]));
const entries = [];
for (const feature of areas) {
  const { id, name, country } = feature.properties, polygons = feature.geometry.coordinates;
  const directory = path.join(target, 'areas', id);
  await mkdir(directory, { recursive: true });
  const region = path.join(directory, 'outline.geojson');
  await writeFile(region, JSON.stringify(feature.geometry));
  console.log(name);
  await build(path.join(directory, 'map.pmtiles'), async part => {
    await run(pmtiles, ['extract', '-q', path.join(root, '.cache/maps/europe.pmtiles'), part + '.whole', `--region=${region}`]);
    if (landuse) await rewrite(part + '.whole', part, tile => strip(tile, 'landuse', landuse));
    await (landuse ? rm(part + '.whole') : rename(part + '.whole', part));
  });
  await build(path.join(directory, 'terrain.pmtiles'), part => run(pmtiles, ['extract', '-q', path.join(root, '.cache/maps/terrain.pmtiles'), part, `--region=${region}`]));
  const extract = catalogueSource.areas.find(area => area.id === id).extract;
  await build(path.join(directory, 'search.index'), part => run(searchBinary, ['build', '--bounds', bounds(polygons).join(','), part,
    path.join(downloads, 'register'), `${path.join(downloads, 'osm', extract.replace('/', '-'))}.osm.pbf=${extracts.get(extract)}`]));
  await build(path.join(directory, 'cycling.json'), part => writeFile(part, JSON.stringify(cycling.all(bounds(polygons)))));
  const own = [];
  for (const file of ['map.pmtiles', 'terrain.pmtiles', 'search.index', 'cycling.json']) {
    const at = path.join(directory, file);
    own.push({ path: `areas/${id}/${file}`, bytes: (await stat(at)).size, pieces: await pieces(at) });
  }
  const touched = squaresOf(polygons).filter(square => squares[square]);
  entries.push({ id, name, country, bounds: bounds(polygons), files: own, squares: touched,
    bytes: own.reduce((sum, file) => sum + file.bytes, 0) + touched.reduce((sum, square) => sum + squares[square].bytes, 0) });
}

// A build of some areas keeps the others' entries.
const cataloguePath = path.join(target, 'catalogue.json');
const previous = chosen && await exists(cataloguePath) ? JSON.parse(await readFile(cataloguePath, 'utf8')).areas : [];
const order = features.map(feature => feature.properties.id);
const all = [...previous.filter(area => !entries.some(entry => entry.id === area.id)), ...entries]
  .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
await writeFile(cataloguePath, JSON.stringify({ built: new Date().toISOString(), pieceBytes, routing: { files, squares }, areas: all }, null, 1) + '\n');
const mb = bytes => `${Math.round(bytes / 1e6)} MB`;
for (const area of entries) {
  const [map, terrain, search, points] = area.files;
  console.log(`${area.name.padEnd(24)} ${mb(area.bytes).padStart(7)}  (map ${mb(map.bytes)}, relief ${mb(terrain.bytes)}, search ${mb(search.bytes)}, cycling ${mb(points.bytes)}, routing ${area.squares.length} squares)`);
}

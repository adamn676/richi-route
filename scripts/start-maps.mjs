import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { access, open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PMTiles } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { createImagery, imageryRevision, validTile } from './imagery/service.mjs';
import imageryConfig from './imagery.json' with { type: 'json' };
import { openCyclingPoints } from './cycling/points.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let cycling;
try {
  const file = path.join(root, '.cache/cycling/points.sqlite');
  await access(file);
  cycling = openCyclingPoints(file);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.warn('Cycling points are not installed. Run npm run cycling:setup.');
}
let imagery;
try { imagery = await createImagery(root); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.warn('European imagery is not installed. Run npm run imagery:setup.');
}
// Versioned tile URLs, so browsers drop cached tiles when the imagery or its regional mosaic changes.
const tileVersion = (imagery?.revision ?? imageryRevision).slice(0, 16);
const imageryMetadata = Buffer.from(JSON.stringify({
  tilejson: '3.0.0', name: 'European imagery', format: 'jpg',
  tiles: [`/maps/imagery/{z}/{x}/{y}.jpg?v=${tileVersion}`], minzoom: 0, maxzoom: 20,
  bounds: imageryConfig.bounds,
  attribution: [imageryConfig.sentinel.attribution, ...[...imageryConfig.countries, ...(imageryConfig.regions ?? [])].map(country => country.attribution),
    '<a href="https://www.geoboundaries.org/">Country masks: geoBoundaries</a>',
    '<a href="https://creativecommons.org/licenses/by-sa/2.0/">Austria boundary: BEV, CC BY-SA 2.0</a>',
  ].join(' · '),
}));
const overviewMetadata = Buffer.from(JSON.stringify({
  tilejson: '3.0.0', name: 'European imagery overview', format: 'jpg',
  tiles: ['/maps/imagery-overview/{z}/{x}/{y}.jpg'], minzoom: 0, maxzoom: 8,
  bounds: imageryConfig.bounds, attribution: imageryConfig.sentinel.attribution,
}));
const fastImageryMetadata = Buffer.from(JSON.stringify({ ...JSON.parse(imageryMetadata), name: 'European imagery, national tiles',
  tiles: [`/maps/imagery-fast/{z}/{x}/{y}.jpg?v=${tileVersion}`],
}));
const directory = path.join(root, '.cache/maps');
const archivePath = process.env.RICHIROUTE_MAP_FILE ?? path.join(directory, 'europe.pmtiles');
let file;
try { file = await open(archivePath); }
catch (error) { throw new Error('Local map archive is missing. Run npm run maps:setup first.', { cause: error }); }
const info = await file.stat();
function localArchive(handle, filename) {
  return new PMTiles({
    getKey: () => filename,
    async getBytes(offset, length) {
      const data = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(data, read, length - read, offset + read);
        if (!bytesRead) throw new Error('Truncated map archive.');
        read += bytesRead;
      }
      return { data: data.buffer };
    },
  });
}
const archive = localArchive(file, archivePath);
let terrainFile, terrainArchive, terrainHeader, terrainEtag;
try {
  const filename = path.join(directory, 'terrain.pmtiles');
  terrainFile = await open(filename);
  terrainArchive = localArchive(terrainFile, filename);
  terrainHeader = await terrainArchive.getHeader();
  const info = await terrainFile.stat();
  terrainEtag = `"${info.size}-${Math.trunc(info.mtimeMs)}"`;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.warn('Terrain is not installed. Run npm run terrain:setup.');
}
const header = await archive.getHeader();
const bounds = [header.minLon, header.minLat, header.maxLon, header.maxLat];
// A calm light map, so the route, cycle paths and points stand out: off-white land, soft greens, white minor roads with
// light outlines, pale main roads, and motorways, which bicycles may not use, in grey.
const flavor = { ...namedFlavor('light'),
  background: '#f4f4f1', earth: '#f4f4f1', water: '#a8d2e6', buildings: '#e2e0da',
  park_a: '#e1eed5', park_b: '#d2e7bf', wood_a: '#d9eacb', wood_b: '#c4dfb0',
  scrub_a: '#e4edd6', scrub_b: '#d6e6c4', industrial: '#ebebe7', pedestrian: '#efede6', hospital: '#efe8e7', school: '#efece5',
  minor_a: '#ffffff', minor_b: '#ffffff', minor_service: '#ffffff', other: '#bdb7aa', railway: '#b9bfbd',
  minor_casing: '#c3c8c1', minor_service_casing: '#d3d7d0', bridges_minor_casing: '#c3c8c1',
  major: '#fdf5e1', link: '#fdf5e1', major_casing_early: '#c9c1ad', major_casing_late: '#c9c1ad', link_casing: '#c9c1ad',
  bridges_major: '#fdf5e1', bridges_link: '#fdf5e1', bridges_major_casing: '#c9c1ad', bridges_link_casing: '#c9c1ad',
  highway: '#e4e1da', highway_casing_early: '#c6c2b8', highway_casing_late: '#c6c2b8',
  bridges_highway: '#e4e1da', bridges_highway_casing: '#c6c2b8',
  landcover: { ...namedFlavor('light').landcover, forest: '#c9e2b8', grassland: '#e6eed8',
    farmland: '#f1f0e6', urban_area: '#ecece8', scrub: '#d6e6c4' },
  roads_label_minor: '#5f6762', roads_label_major: '#4b524e',
  subplace_label: '#757c77', subplace_label_halo: '#f4f4f1',
  city_label: '#2f3834', city_label_halo: '#f4f4f1',
  state_label: '#7a817c', country_label: '#5c645f', ocean_label: '#4f7f95',
};
const style = Buffer.from(JSON.stringify({
  version: 8,
  glyphs: '/maps/fonts/{fontstack}/{range}.pbf',
  sprite: '/maps/sprites/v4/light',
  sources: { europe: {
    type: 'vector', tiles: ['/maps/tiles/{z}/{x}/{y}.mvt'],
    minzoom: header.minZoom, maxzoom: header.maxZoom, bounds,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>',
  } },
  layers: layers('europe', flavor, { lang: 'de' }).flatMap(layer => {
    if (layer.id === 'pois') return [{ ...layer, minzoom: 16 }];
    if (layer.id === 'buildings') return [{ ...layer, paint: { ...layer.paint,
      'fill-opacity': 1, 'fill-outline-color': '#d4d1ca' } }];
    if (layer.id === 'landuse_park') return [{ ...layer, paint: { ...layer.paint,
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6, .25, 9, 1] } }];
    // Borders in the place names' ink, dashed as maps mark them: countries growing with the zoom, so that they read in
    // the overview; regions lighter and thinner.
    if (layer.id === 'boundaries_country') return [{ ...layer, layout: { ...layer.layout, 'line-join': 'round' }, paint: { ...layer.paint,
      'line-color': flavor.country_label, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, .9, 8, 1.3, 12, 1.6], 'line-dasharray': [4, 2] } }];
    if (layer.id === 'boundaries') return [{ ...layer, paint: { ...layer.paint,
      'line-color': '#a9aea9', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, .5, 10, .8] } }];
    return [layer];
  }),
}));
await Promise.all(['fonts/Noto Sans Regular/0-255.pbf', 'sprites/v4/light.json'].map(name => readFile(path.join(directory, 'assets', name))));
const etag = `"${info.size}-${Math.trunc(info.mtimeMs)}"`;
const styleEtag = `"${createHash('sha256').update(style).digest('hex')}"`;
const types = { '.json': 'application/json', '.png': 'image/png', '.pbf': 'application/x-protobuf' };
const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
  }
  try {
    const url = new URL(request.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    let data, type, tileEtag;
    if (pathname === '/cycling.json') {
      if (!cycling) { response.writeHead(503); response.end('Cycling data is not installed'); return; }
      try { data = Buffer.from(JSON.stringify(cycling.get(url.searchParams.get('bbox')))); }
      catch (error) { if (!(error instanceof RangeError)) throw error; response.writeHead(400); response.end(error.message); return; }
      type = 'application/json';
      tileEtag = `"${createHash('sha256').update(data).digest('hex')}"`;
    }
    else if (pathname === '/style.json') { data = style; type = 'application/json'; }
    else if (pathname === '/terrain.json') {
      if (!terrainHeader) { response.writeHead(503); response.end('Terrain is not installed'); return; }
      data = Buffer.from(JSON.stringify({ tilejson: '3.0.0', name: 'European terrain',
        tiles: ['/maps/terrain/{z}/{x}/{y}.webp'], minzoom: terrainHeader.minZoom, maxzoom: terrainHeader.maxZoom,
        bounds: [terrainHeader.minLon, terrainHeader.minLat, terrainHeader.maxLon, terrainHeader.maxLat],
        attribution: 'Relief: <a href="https://mapterhorn.com/attribution/">Mapterhorn · Datenquellen</a>',
      }));
      type = 'application/json'; tileEtag = terrainEtag;
    }
    else if (pathname === '/imagery.json') {
      data = imageryMetadata; type = 'application/json';
    }
    else if (pathname === '/imagery-fast.json') { data = fastImageryMetadata; type = 'application/json'; }
    else if (pathname === '/imagery-overview.json') { data = overviewMetadata; type = 'application/json'; }
    else {
      const overviewTile = /^\/imagery-overview\/([0-8])\/(\d{1,3})\/(\d{1,3})\.jpg$/.exec(pathname);
      const imageTile = /^\/imagery(?:-fast)?\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})\.jpg$/.exec(pathname);
      const tile = /^\/tiles\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})\.mvt$/.exec(pathname);
      const terrainTile = /^\/terrain\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})\.webp$/.exec(pathname);
      if (terrainTile) {
        const [z, x, y] = terrainTile.slice(1).map(Number);
        if (!terrainArchive) { response.writeHead(503); response.end(); return; }
        if (!validTile(z, x, y) || z > terrainHeader.maxZoom) { response.writeHead(404); response.end(); return; }
        const result = await terrainArchive.getZxy(z, x, y);
        if (!result) { response.writeHead(204); response.end(); return; }
        data = Buffer.from(result.data); type = 'image/webp'; tileEtag = terrainEtag;
      } else if (overviewTile) {
        const [z, x, y] = overviewTile.slice(1).map(Number);
        if (!validTile(z, x, y)) { response.writeHead(404); response.end(); return; }
        data = await readFile(path.join(root, '.cache/imagery/overview', String(z), String(x), `${y}.jpg`));
        type = 'image/jpeg';
      } else if (imageTile) {
        const [z, x, y] = imageTile.slice(1).map(Number);
        if (!validTile(z, x, y)) { response.writeHead(404); response.end(); return; }
        if (!imagery) { response.writeHead(503); response.end(); return; }
        const controller = new AbortController();
        response.once('close', () => controller.abort());
        const result = await imagery.getTile(z, x, y, controller.signal, { regional: !pathname.startsWith('/imagery-fast/') });
        if (response.destroyed) return;
        data = result.data; type = 'image/jpeg'; tileEtag = result.etag;
        response.setHeader('X-Imagery-Sources', result.sources.join(','));
        response.setHeader('X-Imagery-Cache', result.cached ? 'hit' : 'miss');
        response.setHeader('X-Imagery-Degraded', result.degraded || result.stale ? '1' : '0');
        response.setHeader('Cache-Control', result.degraded || result.stale ? 'no-store' : 'public, max-age=3600');
      } else if (tile) {
        const [z, x, y] = tile.slice(1).map(Number);
        if (z > header.maxZoom || x >= 2 ** z || y >= 2 ** z) {
          response.writeHead(404); response.end(); return;
        }
        const result = await archive.getZxy(z, x, y);
        if (!result) { response.writeHead(204); response.end(); return; }
        data = Buffer.from(result.data); type = 'application/vnd.mapbox-vector-tile';
      } else if (/^\/(fonts|sprites)\/[\w /@.,-]+\.(pbf|png|json)$/.test(pathname)
        && !pathname.split('/').includes('..')) {
        data = await readFile(path.join(directory, 'assets', pathname));
        type = types[path.extname(pathname)];
      } else { response.writeHead(404); response.end(); return; }
    }
    const responseEtag = pathname.startsWith('/imagery') || pathname.startsWith('/terrain') || pathname === '/cycling.json'
      ? tileEtag ?? `"${createHash('sha256').update(data).digest('hex')}"`
      : pathname === '/style.json' ? styleEtag : etag;
    if (request.headers['if-none-match'] === responseEtag) { response.writeHead(304); response.end(); return; }
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length,
      'Cache-Control': response.getHeader('Cache-Control') ?? (pathname.endsWith('.json') ? 'no-cache' : 'public, max-age=3600'),
      ETag: responseEtag, 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (response.destroyed) return;
    if (error.code === 'ENOENT') response.writeHead(404);
    else if (error instanceof URIError) response.writeHead(400);
    else { console.error(error.message); response.writeHead(500); }
    response.end();
  }
});
const port = Number(process.env.MAPS_PORT ?? 8088);
server.listen(port, '127.0.0.1', () => console.log(`Local maps: http://127.0.0.1:${port}, zoom ${header.minZoom}–${header.maxZoom}, bounds ${bounds.join(', ')}`));
function shutdown() { imagery?.close(); cycling?.close(); server.close(() => { void file.close(); void terrainFile?.close(); }); }
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

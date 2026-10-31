import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

// Offline areas with made-up packages: loading into the browser's file system, a broken download going on where it
// stopped, a damaged piece refused, stopping, deleting without taking a neighbour's shared routing square, a reload,
// and newer data replacing only the files that changed.
const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));

const pieceBytes = 64 * 1024;
const fileBytes = new Map();
const content = (path, length, version = 0) => {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + path.length * 7 + version) % 251;
  fileBytes.set(path, bytes);
  return bytes;
};
const entry = (path, length, version) => {
  const bytes = content(path, length, version);
  return { path, bytes: length, pieces: Array.from({ length: Math.ceil(length / pieceBytes) },
    (_, i) => createHash('sha256').update(bytes.subarray(i * pieceBytes, (i + 1) * pieceBytes)).digest('hex')) };
};
const own = (id, sizes, version) => ['map.pmtiles', 'terrain.pmtiles', 'search.index'].map((name, i) => entry(`areas/${id}/${name}`, sizes[i], version));
// Steiermark and Kärnten share a routing square; Wien has one of its own.
const squares = { E14_N46: entry('routing/E14_N46.square', 150_000), E15_N47: entry('routing/E15_N47.square', 90_000), E16_N48: entry('routing/E16_N48.square', 40_000) };
let catalogue = { built: 'test', pieceBytes, routing: { squares }, areas: [
  { id: 'at-6', bounds: [13.56, 46.61, 16.17, 47.83], files: own('at-6', [300_000, 70_000, 50_000]), squares: ['E14_N46', 'E15_N47'] },
  { id: 'at-2', bounds: [12.65, 46.37, 15.07, 47.13], files: own('at-2', [200_000, 60_000, 40_000]), squares: ['E14_N46'] },
  { id: 'at-9', bounds: [16.18, 48.12, 16.58, 48.32], files: own('at-9', [100_000, 20_000, 30_000]), squares: ['E16_N48'] },
] };
const sizeOf = id => { const area = catalogue.areas.find(a => a.id === id); return [...area.files, ...area.squares.map(s => squares[s])].reduce((sum, f) => sum + f.bytes, 0); };

const requests = [];
// A download to cut short, one with a damaged piece, one held back until released.
let cut = null, damage = null, hold = null;
await context.route(`${origin}/offline/**`, async route => {
  const path = new URL(route.request().url()).pathname.replace('/offline/', '');
  if (path === 'catalogue.json') return route.fulfill({ json: catalogue });
  const bytes = fileBytes.get(path), range = route.request().headers().range;
  requests.push({ path, range });
  if (!bytes) return route.fulfill({ status: 404 });
  if (hold === path) await new Promise(resolve => { hold = resolve; });
  const from = Number(/bytes=(\d+)-/.exec(range ?? '')?.[1] ?? 0);
  let body = Buffer.from(bytes.subarray(from));
  if (cut === path) { cut = null; body = body.subarray(0, pieceBytes * 2 + 1000); }
  if (damage === path) { damage = null; body[pieceBytes + 5] ^= 1; }
  return route.fulfill({ status: from ? 206 : 200, body, headers: from ? { 'Content-Range': `bytes ${from}-${bytes.length - 1}/${bytes.length}` } : {} });
});

const page = await context.newPage();
await page.goto(origin);
await page.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();
const store = fn => page.evaluate(fn => new Function('s', `return (${fn})(s)`)(document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('offline-areas')), fn.toString());
const choose = id => store(`s => { s.selected = '${id}'; }`);
const status = id => store(`s => s.states['${id}']?.status ?? null`);
const ready = id => page.waitForFunction(id => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('offline-areas').states[id]?.status === 'ready', id);
const stored = () => page.evaluate(async () => {
  const found = {};
  async function walk(directory, prefix) {
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === 'directory') await walk(handle, `${prefix}${name}/`);
      else found[prefix + name] = (await handle.getFile()).size;
    }
  }
  await walk(await navigator.storage.getDirectory(), '');
  return found;
});
const alert = page.locator('#sidebar .v-alert');

// The mode opens from the Kartenansicht menu.
await page.getByRole('button', { name: 'Kartenansicht', exact: true }).click();
await page.getByRole('button', { name: 'Offline-Gebiete' }).click();
await page.getByRole('heading', { name: 'Offline-Gebiete' }).waitFor();
await page.getByText('Ein Gebiet auf der Karte wählen.').waitFor();

// Wien loads whole into the file system.
await choose('at-9');
await page.getByText(`Österreich · ${Math.round(sizeOf('at-9') / 1e6) || 1} MB`).waitFor();
await page.getByRole('button', { name: 'Laden', exact: true }).click();
await ready('at-9');
let files = await stored();
for (const path of ['areas/at-9/map.pmtiles', 'areas/at-9/search.index', 'routing/E16_N48.square']) assert.equal(files[path], fileBytes.get(path).length, path);
await page.getByText('Geladen am').waitFor();

// A download cut short reports it; loading again goes on after the last whole piece.
cut = 'areas/at-6/map.pmtiles';
await choose('at-6');
await page.getByRole('button', { name: 'Laden', exact: true }).click();
await alert.filter({ hasText: 'ließ sich nicht laden' }).waitFor();
assert.equal(await status('at-6'), null);
requests.length = 0;
await page.getByRole('button', { name: 'Laden', exact: true }).click();
await ready('at-6');
assert.equal(requests.find(r => r.path === 'areas/at-6/map.pmtiles')?.range, `bytes=${pieceBytes * 2}-`, 'Resumes after the two good pieces');
assert.equal((await stored())['areas/at-6/map.pmtiles'], 300_000);

// A damaged piece is refused and nothing of it kept as good.
damage = 'areas/at-2/map.pmtiles';
await choose('at-2');
await page.getByRole('button', { name: 'Laden', exact: true }).click();
await alert.filter({ hasText: 'beschädigt' }).waitFor();
await page.getByRole('button', { name: 'Laden', exact: true }).click();
await ready('at-2');

// Deleting Kärnten keeps the routing square Steiermark shares.
await page.getByRole('button', { name: 'Löschen', exact: true }).click();
await page.getByRole('dialog').getByRole('button', { name: 'Löschen', exact: true }).click();
await page.waitForFunction(() => !document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('offline-areas').states['at-2']);
files = await stored();
assert.equal(files['areas/at-2/map.pmtiles'], undefined);
assert.equal(files['routing/E14_N46.square'], 150_000, 'Shared square stays');

// Stopping a download leaves nothing behind.
hold = 'areas/at-2/map.pmtiles';
await page.getByRole('button', { name: 'Laden', exact: true }).click();
// The held request has arrived.
while (typeof hold !== 'function') await new Promise(resolve => setTimeout(resolve, 20));
await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
hold();
await page.getByRole('button', { name: 'Laden', exact: true }).waitFor();
assert.equal(await status('at-2'), null);
assert.equal((await stored())['areas/at-2/map.pmtiles'], undefined);
assert.equal((await stored())['routing/E14_N46.square'], 150_000, 'Shared square stays after stopping');

// After a reload, what is on the device is listed, shared squares counted once.
await page.reload();
await page.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();
await page.getByRole('button', { name: 'Kartenansicht', exact: true }).click();
await page.getByRole('button', { name: 'Offline-Gebiete' }).click();
await page.locator('.row-list .v-list-item').nth(1).waitFor();
assert.deepEqual(await page.locator('.row-list .v-list-item-title').allTextContents(), ['Steiermark', 'Wien']);
assert.equal(await store('s => s.usedBytes'), sizeOf('at-6') + sizeOf('at-9'));

// Newer data: only the changed file is fetched again.
catalogue = { ...catalogue, built: 'newer', areas: catalogue.areas.map(area => area.id === 'at-6'
  ? { ...area, files: [area.files[0], entry('areas/at-6/terrain.pmtiles', 80_000, 1), area.files[2]] } : area) };
await page.reload();
await page.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();
await page.getByRole('button', { name: 'Kartenansicht', exact: true }).click();
await page.getByRole('button', { name: 'Offline-Gebiete' }).click();
await page.locator('.row-list').getByText('neuere Daten verfügbar').waitFor();
await choose('at-6');
requests.length = 0;
await page.getByRole('button', { name: 'Aktualisieren', exact: true }).click();
await page.waitForFunction(() => { const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('offline-areas').states['at-6'];
  return s?.status === 'ready' && !s.outdated; });
assert.deepEqual(requests.map(r => r.path), ['areas/at-6/terrain.pmtiles']);
assert.equal((await stored())['areas/at-6/terrain.pmtiles'], 80_000);

// Escape leaves the mode, back to the tabs.
await page.keyboard.press('Escape');
await page.getByRole('tab', { name: 'Route', exact: true }).waitFor();
assert.deepEqual(errors, []);
await browser.close();
console.log('Offline areas: loading, resuming, damaged pieces, stopping, deleting with shared squares, reload and updates passed.');

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const output = '.cache/gpx-surfaces';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
let requests = 0, mode = 'success', release, active = 0, peak = 0;
await page.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'local'));
await page.route('**/tiles/**', route => route.fulfill({ status: 200, contentType: 'application/vnd.mapbox-vector-tile', body: Buffer.alloc(0) }));
await page.route('**/routing/**', async route => {
  requests++; peak = Math.max(peak, ++active);
  const currentMode = mode;
  if (currentMode === 'hold') await new Promise(resolve => { release = resolve; });
  active--;
  if (currentMode === 'fail') return route.fulfill({ status: 503, body: 'unavailable' });
  const coords = new URL(route.request().url()).searchParams.get('lonlats').split('|').map(p => p.split(',').map(Number));
  assert.ok(coords.length <= 64);
  const coordinates = currentMode === 'offset' ? coords.map(([lon, lat]) => [lon, lat + .001]) : coords;
  const end = coordinates.at(-1);
  await route.fulfill({ json: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates },
    properties: { 'track-length': '500', messages: [['Longitude', 'Latitude', 'Distance', 'WayTags'], [Math.round(end[0] * 1e6), Math.round(end[1] * 1e6), 500, 'surface=asphalt']] } }] } }).catch(() => {});
});
const upload = async (name, count = 501) => {
  const xml = '<gpx version="1.1"><trk><name>' + name + '</name><trkseg>' + Array.from({ length: count }, (_, i) => `<trkpt lon="${15.4 + i / 10000}" lat="47.1"><ele>${300 + i / 20}</ele></trkpt>`).join('') + '</trkseg></trk></gpx>';
  await page.getByLabel('GPX-Datei auswählen', { exact: true }).setInputFiles({ name: name + '.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(xml) });
  await page.getByRole('heading', { name, exact: true }).waitFor();
};
const state = () => page.evaluate(() => {
  const p = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
  const gpx = p._s.get('gpx-reference'), route = p._s.get('route');
  return { loading: gpx.surfaceLoading, error: gpx.surfaceError, matched: gpx.surfaceInspection?.estimatedMeters,
    distance: gpx.track?.distanceMeters, surfaces: gpx.surfaces, name: gpx.track?.name,
    geometry: JSON.stringify(gpx.track?.geojson), draft: JSON.stringify({ points: route.points, legs: route.legs, undo: route.undoStack }) };
});
const complete = () => page.waitForFunction(() => {
  const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('gpx-reference');
  return !s.surfaceLoading && s.surfaces !== null;
});
try {
  await page.goto(origin);
  await upload('Surface test');
  const before = await state();
  assert.equal(requests, 0, 'Import never starts surface lookup');
  await page.getByLabel('Trackfarbe', { exact: true }).selectOption('surface');
  await complete();
  const after = await state();
  assert.equal(after.error, '');
  assert.ok(after.matched > after.distance * .99);
  assert.equal(after.geometry, before.geometry); assert.equal(after.draft, before.draft);
  assert.equal(peak, 1);
  await page.getByRole('list', { name: 'Beläge des GPX-Tracks', exact: true }).waitFor();
  const count = requests;
  await page.getByLabel('Trackfarbe', { exact: true }).selectOption('plain');
  await page.getByLabel('Trackfarbe', { exact: true }).selectOption('surface');
  assert.equal(requests, count, 'Reusing surface results sends no requests');
  const chart = page.getByRole('slider', { name: 'Position im GPX-Track', exact: true });
  await chart.focus(); await chart.press('PageUp');
  assert.equal(requests, count);

  mode = 'offset'; await upload('Other road');
  await page.getByLabel('Trackfarbe', { exact: true }).selectOption('surface'); await complete();
  assert.equal((await state()).matched, 0);
  mode = 'fail'; await upload('Unavailable');
  await page.getByLabel('Trackfarbe', { exact: true }).selectOption('surface'); await complete();
  assert.match((await state()).error, /nicht erreichbar/);
  mode = 'success'; await page.getByRole('button', { name: 'Beläge ermitteln', exact: true }).click(); await complete();
  assert.ok((await state()).matched > 0);

  mode = 'hold'; await upload('Cancel');
  await page.getByLabel('Trackfarbe', { exact: true }).selectOption('surface');
  await page.waitForFunction(() => document.querySelector('.gpx__surfaces')?.textContent.includes('Beläge werden geprüft'));
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  await page.getByRole('button', { name: 'Belagprüfung abbrechen', exact: true }).click();
  assert.equal((await state()).loading, false);
  release(); release = undefined;
  await page.waitForTimeout(50);
  assert.equal((await state()).surfaces, null);

  await page.getByRole('button', { name: 'Beläge ermitteln', exact: true }).click();
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  await upload('Replacement');
  release(); release = undefined;
  await page.waitForTimeout(50);
  const replaced = await state();
  assert.equal(replaced.name, 'Replacement'); assert.equal(replaced.surfaces, null); assert.equal(replaced.loading, false);
  assert.equal(await page.getByLabel('Trackfarbe', { exact: true }).inputValue(), 'plain');
  mode = 'success'; await page.getByLabel('Trackfarbe', { exact: true }).selectOption('surface'); await complete();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('list', { name: 'Beläge des GPX-Tracks', exact: true }).scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('button', { name: 'Track entfernen', exact: true }).click();
  assert.equal((await state()).surfaces, null);
  assert.deepEqual(errors, []);
  await writeFile(output + '/browser-report.json', JSON.stringify({ passed: true, requests, peak, initialLookupRequests: count,
    unchangedGeometry: true, cancellationAndReplacement: true }, null, 2));
  console.log('GPX surfaces: opt-in lookup, colours, totals, geometry, cache, failed service, rejected path, retry, cancellation, replacement and mobile passed.');
} finally { release?.(); await browser.close(); }

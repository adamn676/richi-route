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
await page.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'street'));
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
const coordsOf = count => Array.from({ length: count }, (_, i) => [15.4 + i / 10000, 47.1]);
const upload = async (name, count = 1001) => {
  const xml = '<gpx version="1.1"><trk><name>' + name + '</name><trkseg>' + coordsOf(count).map(([lon, lat], i) => `<trkpt lon="${lon}" lat="${lat}"><ele>${300 + i / 20}</ele></trkpt>`).join('') + '</trkseg></trk></gpx>';
  await page.getByLabel('GPX-Datei auswählen', { exact: true }).setInputFiles({ name: name + '.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(xml) });
  await page.waitForFunction(name => document.querySelector('.library input')?.value === name, name);
};
// The opened route's path and how much of it has a known surface.
const state = () => page.evaluate(() => {
  const route = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
  const placed = route.points, legs = placed.slice(0, -1).map((point, i) => route.legs[`${point.id}:${placed[i + 1].id}`]);
  const known = legs.reduce((sum, leg) => sum + leg.surfaces.filter(span => span.surface !== 'unknown')
    .reduce((n, span) => n + (span.toIndex - span.fromIndex) / (leg.coordinates.length - 1) * leg.distanceMeters, 0), 0);
  return { looking: route.surfaceEstimate !== null, known, distance: legs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
    coordinates: legs.flatMap((leg, i) => i ? leg.coordinates.slice(1) : leg.coordinates) };
});
const complete = () => page.waitForFunction(() =>
  document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').surfaceEstimate === null);
try {
  await page.goto(origin);
  await page.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();

  // An opened track gets the surfaces of the roads it follows, a few lookups at a time, without changing its path.
  await upload('Surface test');
  await complete();
  const found = await state();
  assert.ok(found.known > found.distance * .99, `${found.known} of ${found.distance}`);
  assert.deepEqual(found.coordinates, coordsOf(1001));
  assert.ok(peak <= 4, 'The lookup leaves routing slots free for editing');
  await page.getByText('Befestigt', { exact: true }).first().waitFor();

  // A trace along another road lends no surfaces, nor does an unavailable service.
  mode = 'offset'; await upload('Other road'); await complete();
  assert.equal((await state()).known, 0);
  mode = 'fail'; await upload('Unavailable'); await complete();
  assert.equal((await state()).known, 0);

  // Opening another file ends the lookup still running; its late answers change nothing.
  mode = 'hold'; await upload('Held');
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  await page.getByText(/Untergrund wird ermittelt/).waitFor();
  const held = release; release = undefined;
  mode = 'fail'; await upload('Replacement', 501);
  held();
  await complete();
  await page.waitForTimeout(100);
  const replaced = await state();
  assert.deepEqual(replaced.coordinates, coordsOf(501));
  assert.equal(replaced.known, 0);
  assert.deepEqual(errors, []);
  await writeFile(output + '/browser-report.json', JSON.stringify({ passed: true, requests, peak }, null, 2));
  console.log('GPX surfaces: lookup for an opened track, exact path, other road, unavailable service and replacement passed.');
} finally { release?.(); await browser.close(); }

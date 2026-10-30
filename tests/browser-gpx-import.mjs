import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
import { same } from './browser-ui.mjs';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const output = '.cache/gpx-import';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: process.env.PLAYWRIGHT_HEADED !== '1' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const errors = [];
let routingRequests = 0;
await context.addInitScript(origin => {
  if (location.origin === origin) localStorage.setItem('richiroute.review-basemap', 'street');
}, origin);
await context.route('**/tiles/**', route => route.fulfill({ status: 200, contentType: 'application/vnd.mapbox-vector-tile', body: Buffer.alloc(0) }));
// Surfaces of an opened track are looked up by routing; that lookup failing leaves them unknown.
await context.route('**/routing/**', route => { routingRequests++; return route.abort(); });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const gpx = body => `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;
const point = (lon, lat, ele = '') => `<trkpt lon="${lon}" lat="${lat}">${ele === '' ? '' : `<ele>${ele}</ele>`}</trkpt>`;
const upload = (name, contents) => page.getByLabel('GPX-Datei auswählen', { exact: true })
  .setInputFiles({ name, mimeType: 'application/gpx+xml', buffer: Buffer.from(contents) });
// The sidebar's messages; the map reports its own, such as missing terrain data in CI.
const alerts = () => page.locator('.sidebar__messages').getByRole('alert');
const reading = () => page.waitForFunction(() => !document.querySelector('.sidebar__reading'));
const state = () => page.evaluate(() => {
  const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
  return JSON.parse(JSON.stringify({ points: store.points, legs: store.legs }));
});
// The route's legs in order: their kinds, statuses, lengths and the path and heights they make together.
const opened = () => page.evaluate(() => {
  const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
  const placed = store.points;
  const legs = placed.slice(0, -1).map((point, i) => store.legs[`${point.id}:${placed[i + 1].id}`]);
  return { kinds: placed.map(point => point.type === 'stop' ? point.kind : 'shape'), statuses: legs.map(leg => leg?.status),
    coordinates: legs.flatMap((leg, i) => i ? leg.coordinates.slice(1) : leg.coordinates),
    elevations: legs.flatMap((leg, i) => i ? leg.elevations.slice(1) : leg.elevations), distances: legs.map(leg => leg.distanceMeters) };
});
const routeName = () => page.getByLabel('Routenname', { exact: true }).inputValue();
try {
  await page.goto(origin);
  await page.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();

  // There is no separate GPX area: a file opens as the route, from the route's tools.
  assert.equal(await page.getByRole('tab', { name: 'GPX', exact: true }).count(), 0);
  await page.evaluate(async () => {
    const { routingPolicyVersion } = await import('/src/config/routing-policy.ts');
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    const points = [
      { id: 'stop-a', type: 'stop', kind: 'start', coord: [15.4, 47.1], address: 'Hahnhofweg 26, 8010 Graz', userInput: 'Hahnhofweg 26, 8010 Graz', isGeocoding: false },
      { id: 'stop-b', type: 'stop', kind: 'end', coord: [15.5, 47.2], address: 'Roseggerweg, 8044 Graz', userInput: 'Roseggerweg, 8044 Graz', isGeocoding: false },
    ];
    store.restoreDraft({ version: 1, points, legs: { 'stop-a:stop-b': {
      id: 'stop-a:stop-b', fromId: 'stop-a', toId: 'stop-b', fromCoord: points[0].coord, toCoord: points[1].coord,
      coordinates: points.map(p => p.coord), elevations: [300, 400], distanceMeters: 15000, ascentMeters: 100,
      status: 'routed', surfaces: [], routingPolicy: routingPolicyVersion,
    } } });
  });
  const original = await state();

  // A failed file changes nothing.
  await upload('invalid.gpx', gpx(`<trk><trkseg>${point(181, 47)}</trkseg></trk>`));
  await alerts().waitFor();
  await reading();
  same(await state(), original);
  await upload('oversized.gpx', Buffer.alloc(32 * 1024 * 1024 + 1));
  await alerts().filter({ hasText: '32 MB' }).waitFor();
  await upload('many.gpx', gpx(`<trk><trkseg>${'<trkpt lon="15" lat="47"/>'.repeat(250001)}</trkseg></trk>`));
  await alerts().filter({ hasText: '250.000' }).waitFor();
  same(await state(), original);

  // Cancelling stops reading the file and its worker, and leaves no message.
  await page.evaluate(() => {
    const NativeWorker = Worker;
    window.workersStopped = 0;
    window.Worker = class extends NativeWorker { terminate() { window.workersStopped++; super.terminate(); } };
  });
  const big = gpx('<trk><trkseg>' + Array.from({ length: 200000 }, (_, i) => point(15.4 + i / 1e6, 47.1, 300)).join('') + '</trkseg></trk>');
  await upload('big.gpx', big);
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await reading();
  assert.equal(await page.evaluate(() => window.workersStopped), 1);
  assert.deepEqual(await alerts().allInnerTexts(), []);
  same(await state(), original);

  // A long track replaces the route with its exact path and heights, in sections of about 5 km; the route before goes
  // to the recently edited ones, and the confirmation brings it back.
  const length = 50000;
  const coords = Array.from({ length }, (_, i) => [15.4 + i / 500000, 47.1 + Math.sin(i / 1000) / 100]);
  const started = performance.now();
  await upload('long.gpx', gpx('<metadata><name>Große GPX-Runde</name></metadata><trk><trkseg>' +
    coords.map(([lon, lat], i) => point(lon, lat, 300 + i % 50)).join('') + '</trkseg></trk>'));
  await page.getByText('Vorige Route liegt in „Zuletzt bearbeitet“.').waitFor();
  const importMs = Math.round(performance.now() - started);
  const track = await opened();
  same(track.coordinates, coords, 'The route follows the track exactly');
  same(track.elevations, coords.map((_, i) => 300 + i % 50));
  assert.equal(track.kinds[0], 'start');
  assert.equal(track.kinds.at(-1), 'end');
  assert.ok(track.kinds.slice(1, -1).every(kind => kind === 'shape') && track.kinds.length > 3);
  assert.ok(track.statuses.every(status => status === 'routed'));
  assert.ok(track.distances.slice(0, -1).every(distance => distance >= 5000));
  assert.equal(await routeName(), 'Große GPX-Runde', 'Saving suggests the track’s name');
  const recentNames = () => page.evaluate(async () => {
    const { recentRoutes } = await import('/src/services/recent-routes.service.ts');
    return (await recentRoutes.list()).map(row => row.name);
  });
  assert.deepEqual(await recentNames(), ['Hahnhofweg 26 → Roseggerweg']);
  const imported = await state();
  await page.getByRole('button', { name: 'Wiederherstellen', exact: true }).click();
  await page.getByText('„Hahnhofweg 26 → Roseggerweg“ geöffnet.').waitFor();
  same(await state(), original);
  assert.deepEqual(await recentNames(), ['Große GPX-Runde'], 'The route brought back leaves the list as the other one joins it');
  // The track went to the recently edited ones in turn.
  await page.getByRole('button', { name: 'Wiederherstellen', exact: true }).last().click();
  await page.getByText('„Große GPX-Runde“ geöffnet.').waitFor();
  same(await state(), imported);

  // A file dropped anywhere on the map opens the same way.
  const routeCoords = coords.filter((_, i) => i % 50 === 0);
  await page.locator('#map').evaluate((map, xml) => {
    const data = new DataTransfer();
    data.items.add(new File([xml], 'runde.gpx', { type: 'application/gpx+xml' }));
    map.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    map.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, gpx('<trk><name>Runde</name><trkseg>' + routeCoords.map(([lon, lat], i) => point(lon, lat, 300 + i % 20)).join('') + '</trkseg></trk>'));
  await page.waitForFunction(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').points.length > 3);
  await reading();
  same((await opened()).coordinates, routeCoords);
  assert.equal(await routeName(), 'Runde');
  // The stops get their streets in the background.
  await page.waitForFunction(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').waypoints.every(stop => stop.address !== null));
  const runde = await state();
  // Opening a file is one step in the route's history.
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click();
  same(await state(), imported);
  await page.getByRole('button', { name: 'Wiederholen', exact: true }).click();
  same(await state(), runde);
  await page.waitForFunction(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').draftStatus === 'saved');
  await page.reload();
  await page.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').draftLoaded);
  same(await state(), runde, 'An opened track stays the current route');
  await page.screenshot({ path: output + '/desktop.png' });

  // On a phone the sheet makes way for the opened route; the route's tools fit beside their heading.
  await page.setViewportSize({ width: 390, height: 844 });
  await upload('single.gpx', gpx('<trk><name>Kurz</name><trkseg>' + routeCoords.slice(0, 20).map(([lon, lat]) => point(lon, lat, 300)).join('') + '</trkseg></trk>'));
  await page.getByText('Vorige Route liegt in „Zuletzt bearbeitet“.').waitFor();
  assert.match(await page.locator('.editor-layout').getAttribute('class'), /editor-layout--peek/);
  await page.getByRole('button', { name: 'Bereich vergrößern', exact: true }).click();
  for (const button of await page.locator('.planner__tools button').all()) {
    const box = await button.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
  }
  await page.screenshot({ path: output + '/mobile.png' });
  assert.deepEqual(errors, []);
  await writeFile(output + '/report.json', JSON.stringify({ points: length, importMs, routingRequests, exactGeometryAndElevations: true, passed: true }, null, 2) + '\n');
  console.log('GPX import: opening as the route with exact geometry and heights, recently edited and restore, undo, drop on the map, limits, cancellation, reload and mobile passed.');
} finally {
  await context.close();
  await browser.close();
}

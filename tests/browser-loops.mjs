import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

// Loop suggestions with mocked routing and address services: three loops, highlighting, taking one, undo, failure, phone.
const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const output = '.cache/loops';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const errors = [], external = [];
let routing = 'loops';
const start = [15.44, 47.07], rad = Math.PI / 180, kx = 111320 * Math.cos(start[1] * rad), ky = 110540;
// A circular loop in the requested direction, about 6.2 times the radius long, climbing more towards the north.
function loop(radius, direction) {
  const steps = 240, climb = radius / 8 * (1 + Math.cos(direction * rad));
  const centre = [start[0] + Math.sin(direction * rad) * radius / kx, start[1] + Math.cos(direction * rad) * radius / ky];
  const coordinates = Array.from({ length: steps + 1 }, (_, i) => {
    const a = (direction + 180) * rad + i / steps * 2 * Math.PI;
    const [lon, lat] = i === 0 || i === steps ? start : [centre[0] + Math.sin(a) * radius / kx, centre[1] + Math.cos(a) * radius / ky];
    return [+lon.toFixed(6), +lat.toFixed(6), 300 + climb / 2 * (1 - Math.cos(i / steps * 2 * Math.PI))];
  });
  const end = coordinates.at(-1);
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates },
    properties: { 'track-length': String(Math.round(radius * 2 * Math.PI)), messages: [['Longitude', 'Latitude', 'Distance', 'WayTags'],
      [Math.round(end[0] * 1e6), Math.round(end[1] * 1e6), 1, 'highway=tertiary surface=asphalt']] } }] };
}
await context.addInitScript(origin => { if (location.origin === origin) localStorage.setItem('richiroute.review-basemap', 'street'); }, origin);
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin && ['http:', 'https:'].includes(url.protocol)) { external.push(url.href); return route.abort(); }
  return route.fallback();
});
await context.route('**/tiles/**', route => route.fulfill({ status: 200, contentType: 'application/vnd.mapbox-vector-tile', body: Buffer.alloc(0) }));
await context.route('**/routing/**', route => {
  const params = new URL(route.request().url()).searchParams;
  if (params.get('engineMode') === '4') {
    return routing === 'fail' ? route.fulfill({ status: 503, body: 'unavailable' }) : route.fulfill({ json: loop(+params.get('roundTripDistance'), +params.get('direction')) });
  }
  // Snapping a stop: it stays where it is.
  const [lon, lat] = params.get('lonlats').split('|')[0].split(',').map(Number);
  return route.fulfill({ json: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[lon, lat], [lon, lat]] },
    properties: { 'track-length': '0', messages: [] } }] } });
});
// Towns by compass quarter around the start; the start's own street and town.
await context.route('**/geocoding/reverse**', route => {
  const params = new URL(route.request().url()).searchParams, lon = +params.get('lon'), lat = +params.get('lat');
  const home = Math.abs(lon - start[0]) < .002 && Math.abs(lat - start[1]) < .002;
  const bearing = (Math.atan2((lon - start[0]) * kx, (lat - start[1]) * ky) / rad + 360) % 360;
  const town = home ? 'Graz' : ['Nordhausen', 'Ostdorf', 'Südheim', 'Westfeld'][Math.round(bearing / 90) % 4];
  const properties = params.has('layer') ? { type: 'locality', name: 'Ort', city: town } : { type: 'street', name: 'Teststraße', postcode: '8010', city: town };
  return route.fulfill({ json: { features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties }] } });
});
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
const page = await context.newPage();
const store = name => `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('${name}')`;
const mapState = () => page.evaluate(() => {
  const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
  return { loops: map.getSource('loop-suggestions-source')?._data?.features?.length ?? map.getSource('loop-suggestions-source')?.serialize().data.features.length,
    highlight: map.getGlobalState().loopHighlight, selected: map.getGlobalState().loopSelected };
});
const cards = page.getByRole('group', { name: 'Vorschläge', exact: true }).getByRole('button');
const routeState = () => page.evaluate(`(() => { const s = ${store('route')}, l = ${store('loop-suggestions')}; return { distance: s.distanceMeters,
  ascent: s.ascentMeters, end: s.waypoints.at(-1).coord, undo: s.undoStack.length, selected: l.selected,
  loops: l.suggestions?.map(loop => loop.leg.distanceMeters) ?? null }; })()`);
// The map's zoom once it has stopped moving.
const zoom = () => page.evaluate(() => new Promise(resolve => {
  const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
  const settle = () => setTimeout(() => map.isMoving() ? settle() : resolve(map.getZoom()), 400);
  settle();
}));
try {
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Runde vorschlagen', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Vorschläge', exact: true }).isDisabled(), true, 'A loop needs a start');
  await page.evaluate(`${store('route')}.addWaypointByClick([${start}])`);
  await page.waitForFunction(`${store('route')}.waypoints[0].address === 'Teststraße, 8010 Graz'`);
  const before = await routeState();
  await page.getByLabel('Distanz', { exact: true }).fill('40');
  await page.getByLabel('Anstieg', { exact: true }).fill('600');
  await page.getByRole('button', { name: 'Vorschläge', exact: true }).click();
  await cards.first().waitFor();
  const texts = await cards.allInnerTexts();
  assert.equal(texts.length, 3);
  assert.ok(texts.every(text => /^Über (Nordhausen|Ostdorf|Südheim|Westfeld)\n/.test(text)), texts.join(' / '));
  assert.equal(new Set(texts.map(text => text.split('\n')[0])).size, 3, 'Each loop has its own name');
  assert.ok(texts.every(text => /\d+,\d km · \d+ m/.test(text)));

  // First all three in view, none chosen: the route is still the start alone.
  let shown = await routeState();
  assert.equal(shown.selected, null);
  assert.equal(shown.end, null);
  assert.ok((await cards.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-pressed')))).every(pressed => pressed === 'false'));
  await page.waitForFunction(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getLayer('loop-suggestions-line'));
  const overview = await zoom();

  // Selecting a loop shows it as the route, with numbers, surfaces and profile, and zooms to it.
  await cards.first().click();
  await page.getByRole('slider', { name: 'Position in der Route', exact: true }).waitFor();
  shown = await routeState();
  assert.equal(shown.selected, 0);
  assert.equal(await cards.first().getAttribute('aria-pressed'), 'true');
  assert.ok(Math.abs(shown.distance - shown.loops[0]) < 1e-6, 'The route is the loop exactly');
  assert.deepEqual(shown.end, start.map(Number), 'Start and finish meet');
  assert.equal(shown.undo, before.undo + 1, 'Showing a loop is one undo step');
  await page.getByText('Untergrund', { exact: true }).waitFor();
  assert.ok(await zoom() > overview + .3, 'The map zooms to the selected loop');

  // Another loop replaces it in place; the map keeps the others faint and highlights the one pointed at.
  await cards.nth(1).click();
  shown = await routeState();
  assert.equal(shown.selected, 1);
  assert.ok(Math.abs(shown.distance - shown.loops[1]) < 1e-6);
  assert.equal(shown.undo, before.undo + 1, 'Trying another loop adds no undo step');
  await cards.nth(2).hover();
  assert.deepEqual(await mapState(), { loops: 3, highlight: 2, selected: 1 });
  await page.screenshot({ path: output + '/suggestions.png' });

  // Selecting it again goes back to the start and all three loops.
  await cards.nth(1).click();
  shown = await routeState();
  assert.equal(shown.selected, null);
  assert.equal(shown.end, null);
  assert.equal(shown.undo, before.undo);
  assert.equal(shown.loops.length, 3, 'The suggestions stay');
  assert.ok(Math.abs(await zoom() - overview) < .3, 'The map shows all loops again');

  // Discarding drops them; keeping one ends the choice, and one undo returns to the start.
  await cards.nth(2).click();
  await page.getByRole('button', { name: 'Verwerfen', exact: true }).click();
  shown = await routeState();
  assert.deepEqual([shown.end, shown.loops, shown.undo], [null, null, before.undo]);
  await page.getByRole('button', { name: 'Vorschläge', exact: true }).click();
  await cards.first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Übernehmen', exact: true }).isDisabled(), true, 'Keeping needs a selection');
  await cards.first().click();
  await page.getByRole('button', { name: 'Übernehmen', exact: true }).click();
  shown = await routeState();
  assert.equal(shown.loops, null);
  assert.ok(shown.end);
  assert.equal(await page.getByRole('heading', { name: 'Runde vorschlagen', exact: true }).count(), 0);
  assert.equal((await mapState()).loops, 0);
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click();
  await page.getByRole('heading', { name: 'Runde vorschlagen', exact: true }).waitFor();
  assert.equal((await routeState()).end, null, 'Undo returns to the start alone');

  routing = 'fail';
  await page.getByRole('button', { name: 'Vorschläge', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'nicht erreichbar' }).waitFor();
  routing = 'loops';

  // A new route keeps no copy of a start alone, nor of a loop only being looked at.
  const saved = () => page.evaluate(async () => (await (await import('/src/services/route-library.service.ts')).routeLibrary.list()).length);
  const library = await saved();
  await page.getByRole('button', { name: 'Vorschläge', exact: true }).click();
  await cards.first().click();
  await page.getByRole('button', { name: 'Neue Route', exact: true }).click();
  await page.waitForFunction(`!${store('route')}.waypoints[0].coord`);
  assert.equal(await saved(), library, 'A previewed loop is not saved');
  await page.evaluate(`${store('route')}.addWaypointByClick([${start}])`);
  await page.waitForFunction(`${store('route')}.waypoints[0].address`);
  await page.getByRole('button', { name: 'Neue Route', exact: true }).click();
  await page.waitForFunction(`!${store('route')}.waypoints[0].coord`);
  assert.equal(await saved(), library, 'A start alone is not saved');
  // Set as if by a click on the map, which takes the focus from the Start field the new route focused.
  await page.evaluate(`${store('route')}.addWaypointByClick([${start}]); document.activeElement.blur()`);
  await page.waitForFunction(`${store('route')}.waypoints[0].address && !${store('route')}.waypoints[0].snapPending`);

  // On a phone the sheet stays up while choosing, and the cards fit.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Vorschläge', exact: true }).click();
  await cards.first().waitFor();
  await cards.nth(1).click();
  assert.match(await page.locator('.editor-layout').getAttribute('class'), /editor-layout--half/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  for (const card of await cards.all()) {
    const box = await card.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, 'Cards fit a phone');
  }
  await page.screenshot({ path: output + '/mobile.png' });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, [], 'Suggestions stay local');
  console.log('Loop suggestions: start required, three named loops, overview first, select with zoom, switch without undo steps, deselect back to all, discard, keep, service failure and phone layout passed.');
} finally { await browser.close(); }

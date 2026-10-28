import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
import { chooseBasemap, openRoute } from './browser-ui.mjs';
import { hahnhofweg } from './route-examples.ts';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const output = '.cache/search';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, hasTouch: true });
await context.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'street'));
const externalRequests = [];
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) {
    externalRequests.push(url.href); return route.abort();
  }
  return route.continue();
});
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
let queries = 0;
page.on('request', request => { if (request.url().startsWith(origin + '/geocoding/api/')) queries++; });
const points = () => page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').waypoints);
const result = name => ({ features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [15.44, 47.07] }, properties: { name, city: 'Graz' } }] });
try {
  await page.goto(origin);
  const start = page.getByRole('combobox', { name: 'Start', exact: true });
  const end = page.getByRole('combobox', { name: 'Ziel', exact: true });
  await start.waitFor();
  await start.fill('Gr');
  await page.waitForTimeout(450);
  assert.equal(queries, 0);
  await start.fill('Graz Hauptplatz');
  await page.getByRole('option').first().waitFor();
  assert.match(await page.getByRole('option').first().textContent(), /Hauptplatz.*Graz/);
  await start.press('ArrowDown');
  await start.press('Enter');
  await page.waitForFunction(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').waypoints[0].coord);
  assert.match((await points())[0].address, /Hauptplatz/);
  assert.equal(queries, 1, 'Selecting a suggestion does not repeat the search');
  await end.fill('Graz Hilmteich');
  await page.getByRole('option').first().waitFor();
  await page.getByRole('option').first().click();
  await page.waitForFunction(() => {
    const route = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    return !route.pendingSnapCount && !route.pendingLegCount && Object.values(route.legs).some(leg => leg.status === 'routed');
  }, {}, { timeout: 60000 });
  const placed = await points();
  assert.ok(placed.every(point => point.coord && !point.snapError));
  assert.equal(queries, 2);
  await page.getByRole('button', { name: 'Auf Route zoomen', exact: true }).click();
  await chooseBasemap(page, 'street');
  await page.waitForFunction(() => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    const ids = map.getStyle().layers.filter(layer => layer.id.startsWith('basemap-vector-') && layer.type === 'line').map(layer => layer.id);
    return ids.length && !map.isMoving() && map.queryRenderedFeatures({ layers: ids }).length > 30;
  }, {}, { timeout: 60000 });
  await start.scrollIntoViewIfNeeded();
  await page.screenshot({ path: output + '/route-from-search.png' });

  // A route opened as a whole moves the map to it, and its stops get the streets they lie on.
  const mapView = () => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
  await page.evaluate(`(${mapView})().jumpTo({ center: [16.37, 48.21], zoom: 12 })`);
  await page.getByRole('button', { name: 'Neue Route', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').waypoints[0].coord);
  await openRoute(page, hahnhofweg);
  await page.waitForFunction(() => {
    const route = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    return route.waypoints.every(point => point.address);
  }, {}, { timeout: 30000 });
  const named = await points();
  assert.match(named[0].address, /^Hahnhofweg, 8010 Graz$/);
  assert.match(named[1].address, /Roseggerweg, 8044 Graz$/);
  assert.equal(await start.inputValue(), named[0].address);
  assert.ok(named.every(point => point.userInput === point.address));
  await page.waitForFunction(mapView => {
    const map = eval(`(${mapView})`)(), bounds = map.getBounds();
    const route = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    return !map.isMoving() && route.waypoints.every(point => bounds.contains(point.coord));
  }, mapView.toString(), { timeout: 10000 });
  // Two steps back: the empty new route, then the searched route with its addresses.
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click();
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click();
  assert.match(await start.inputValue(), /Hauptplatz/);

  // An address starts on its own street: Georgigasse 95 lies nearer a park path to the south than its street.
  await start.fill('Georgigasse 95');
  await page.getByRole('option').first().waitFor();
  await start.press('ArrowDown');
  await start.press('Enter');
  await page.waitForFunction(() => {
    const stop = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').waypoints[0];
    return stop.address?.startsWith('Georgigasse 95') && !stop.snapPending;
  }, {}, { timeout: 30000 });
  const house = (await points())[0].coord;
  assert.ok(house[1] > 47.0768, `On Georgigasse, north of the house, not in the park: ${house}`);
  // Typing is no undo step, so the field keeps the text; the start itself returns.
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click();
  assert.deepEqual((await points())[0].coord, placed[0].coord);

  // From here, controlled responses exercise errors and races for repeatable failures.
  let mode = 'empty';
  let releaseSlow, startedSlow;
  const slowStarted = new Promise(resolve => { startedSlow = resolve; });
  const slowRelease = new Promise(resolve => { releaseSlow = resolve; });
  await page.route('**/geocoding/api/**', async route => {
    const q = new URL(route.request().url()).searchParams.get('q');
    if (q === 'Slow result') {
      startedSlow(); await slowRelease;
      await route.fulfill({ json: result('Old result') }); return;
    }
    if (mode === 'offline') { await route.abort(); return; }
    await route.fulfill(mode === 'limited' ? { status: 429, body: '' }
      : { json: mode === 'empty' ? { features: [] }
        : mode === 'many' ? { features: Array.from({ length: 8 }, (_, i) => result(`Mobile result ${i}`).features[0]) }
        : result('New result') });
  });
  await start.fill('No results');
  await page.getByText('Keine Adresse gefunden.', { exact: false }).waitFor();
  assert.deepEqual((await points())[0].coord, placed[0].coord);
  mode = 'limited'; await start.fill('Limited query');
  await page.getByRole('alert').filter({ hasText: 'Zu viele Suchanfragen' }).waitFor();
  mode = 'offline'; await start.fill('Offline query');
  await page.getByRole('alert').filter({ hasText: 'Adresssuche nicht erreichbar' }).waitFor();
  mode = 'success'; await start.fill('Slow result'); await slowStarted;
  await start.fill('Fast result');
  await page.getByRole('option', { name: 'New result, Graz', exact: true }).waitFor();
  releaseSlow();
  await page.waitForTimeout(150);
  assert.equal(await page.getByRole('option', { name: 'Old result, Graz' }).count(), 0);
  const beforeEnter = queries;
  await start.press('Enter');
  await page.waitForFunction(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').waypoints[0].address === 'New result, Graz');
  assert.equal(queries, beforeEnter, 'Enter reuses the loaded first suggestion');
  await start.fill('Cancel query');
  await start.press('Escape');
  await page.waitForTimeout(500);
  assert.equal(await page.getByRole('listbox').count(), 0);
  // The field's clear button removes the stop with its text and keeps the cursor there.
  await start.fill('Wird gelöscht');
  await page.getByRole('button', { name: 'Start leeren', exact: true }).click();
  assert.equal(await start.inputValue(), '');
  assert.equal((await points())[0].coord, null, 'The start is removed, not only its text');
  assert.equal(await start.evaluate(field => field === document.activeElement), true, 'The field keeps the focus');
  await page.setViewportSize({ width: 390, height: 844 });
  mode = 'many';
  await start.fill('Mobile query');
  await page.getByRole('option', { name: 'Mobile result 0, Graz', exact: true }).waitFor();
  const panel = await page.locator('.editor-layout__sidebar').boundingBox();
  const menu = await page.getByRole('listbox').boundingBox();
  assert.ok(menu.y >= panel.y && menu.y + menu.height <= panel.y + panel.height + 1, 'Suggestions must be inside the visible sidebar');
  assert.ok((await start.boundingBox()).y >= panel.y, 'The input stays visible above the suggestions');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: menu.x + menu.width / 2, y: menu.y + menu.height * .8 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: menu.x + menu.width / 2, y: menu.y + menu.height * .3 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  assert.equal(await start.inputValue(), 'Mobile query', 'Touch scrolling must not select a suggestion');
  assert.equal(await page.getByRole('listbox').getByRole('option').count(), 8);
  await page.waitForFunction(() => {
    for (let box = document.querySelector('[role=listbox]'); box; box = box.parentElement) if (box.scrollTop > 0) return true;
    return false;
  });
  // The first arrow moves the focus into the list; the next ones walk it.
  await start.press('ArrowDown');
  for (let i = 1; i < 8; i++) await page.keyboard.press('ArrowDown');
  const lastOption = page.getByRole('option', { name: 'Mobile result 7, Graz', exact: true });
  const lastBox = await lastOption.boundingBox();
  assert.ok(lastBox.y >= menu.y && lastBox.y + lastBox.height <= menu.y + menu.height, 'Keyboard selection scrolls within the suggestion list');
  await page.screenshot({ path: output + '/mobile-suggestions.png' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await lastOption.tap();
  assert.equal(await page.getByRole('listbox').count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, [], 'Search and street maps stay local');
  await writeFile(output + '/report.json', JSON.stringify({ passed: true, liveQueries: 2,
    routedEndpoints: placed.map(point => ({ address: point.address, coord: point.coord })),
    keyboard: true, pointer: true, mobile: true, empty: true, rateLimit: true, offline: true, staleResults: true }, null, 2));
  console.log('Search: live Photon suggestions and BRouter route, keyboard/click selection, empty/offline/rate-limit states, cancellation and stale results passed.');
} finally { await browser.close(); }

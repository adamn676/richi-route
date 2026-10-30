import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
import { chooseBasemap, closeMenus } from './browser-ui.mjs';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const output = '.cache/online-maps';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(origin) && request.url().startsWith('http')) external.push(request.url()); });
  // The volunteer tile servers prohibit automated pan/zoom tests; validate the integration with fixtures.
  const fixture = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e8eadc'; ctx.fillRect(0, 0, 256, 256);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  const tiles = { opentopomap: 0, waymarkedtrails: 0 };
  const failing = new Set();
  for (const [name, pattern] of [['opentopomap', 'https://*.tile.opentopomap.org/**'],
    ['waymarkedtrails', 'https://tile.waymarkedtrails.org/**']]) {
    await page.route(pattern, route => {
      if (failing.has(name)) return route.abort();
      tiles[name]++;
      return route.fulfill({ contentType: 'image/png', body: fixture });
    });
  }
  await page.addInitScript(() => {
    if (!localStorage.getItem('richiroute.review-basemap')) localStorage.setItem('richiroute.review-basemap', 'street');
  });
  await page.goto(origin);
  await page.waitForFunction(() => {
    const map = document.querySelector('.gpx-reference-layer')?.__vueParentComponent.props.map;
    return map?.getSource('basemap-vector-europe') && map.loaded();
  });
  assert.deepEqual(external, [], 'Local maps do not contact online providers');
  await page.evaluate(async () => {
    const { routingPolicyVersion } = await import('/src/config/routing-policy.ts');
    const route = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    const coordinates = [[15.43, 47.07], [15.44, 47.075], [15.45, 47.08]];
    const points = [coordinates[0], coordinates[2]].map((coord, i) => ({
      id: `stop-${i}`, type: 'stop', kind: i ? 'end' : 'start', coord, address: null, userInput: String(i), isGeocoding: false,
    }));
    route.restoreDraft({ version: 1, points, legs: { 'stop-0:stop-1': {
      id: 'stop-0:stop-1', fromId: 'stop-0', toId: 'stop-1', fromCoord: points[0].coord, toCoord: points[1].coord,
      coordinates, elevations: [350, 360, 370], distanceMeters: 2000, ascentMeters: 20,
      status: 'routed', surfaces: [], routingPolicy: routingPolicyVersion,
    } } });
  });
  await page.waitForFunction(async () => {
    const source = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getSource('segments-source');
    return source?.loaded() && (await source.getData()).features.length > 0;
  });
  const geometry = await page.evaluate(async () => JSON.stringify(await document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getSource('segments-source').getData()));
  await page.evaluate(() => {
    window.onlineMapErrors = [];
    document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map
      .on('error', event => window.onlineMapErrors.push(event.error?.message));
  });
  const states = [];
  const mapIs = (page, check, arg) => page.waitForFunction(check, arg, { timeout: 60000 });
  for (const mode of ['opentopomap', 'street']) {
    await chooseBasemap(page, mode);
    await mapIs(page, mode => {
      const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
      const online = map.getStyle().layers.filter(layer => layer.id.startsWith('online-') && layer.layout?.visibility === 'visible');
      return map.loaded() && map.areTilesLoaded() && (mode === 'street' ? !online.length : online.length === 1 && online[0].id === `online-${mode}`);
    }, mode);
    assert.equal(await page.getByRole('alert').count(), 0, `${mode}: ${JSON.stringify(await page.evaluate(() => window.onlineMapErrors))}`);
    if (mode !== 'street') assert.ok(tiles[mode] > 0, `${mode} loads its tiles`);
    const state = await page.evaluate(mode => {
      const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
      return { mode, cyclewaysVisible: map.getLayoutProperty('cycling-cycleways', 'visibility'), localGlyphs: map.getGlyphs()?.includes('/maps/fonts/'),
        vectorVisible: map.getStyle().layers.some(layer => layer.id.startsWith('basemap-vector-') && layer.layout?.visibility !== 'none') };
    }, mode);
    assert.equal(state.cyclewaysVisible, 'visible', 'Overlays stay on every map');
    assert.equal(state.vectorVisible, mode === 'street', `${mode}: the local map shows only on Karte`);
    assert.equal(state.localGlyphs, true, 'Overlay labels keep the local fonts');
    assert.equal(await page.evaluate(async () => JSON.stringify(await document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getSource('segments-source').getData())), geometry);
    assert.ok(await page.evaluate(() => {
      const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
      const layers = map.getStyle().layers.filter(layer => 'source' in layer && layer.source === 'segments-source' && layer.type === 'line');
      return map.queryRenderedFeatures({ layers: layers.map(layer => layer.id) }).length;
    }), `${mode}: route remains visible`);
    // The credits are in view, OpenStreetMap among them once.
    assert.equal((await page.locator('.sidebar__credits').innerText()).match(/OpenStreetMap/g)?.length, 1, `${mode}: one OpenStreetMap credit`);
    assert.equal(await page.locator('.sidebar__credits a:not([target="_blank"])').count(), 0, `${mode}: credits open their links in a new tab`);
    states.push(state);
    await page.screenshot({ path: `${output}/${mode}.png` });
  }

  // A failed online map says so and recovers with "Erneut laden".
  failing.add('opentopomap');
  await page.evaluate(() => localStorage.setItem('richiroute.review-basemap', 'opentopomap'));
  await page.reload();
  await page.getByRole('alert').filter({ hasText: 'OpenTopoMap' }).waitFor();
  failing.delete('opentopomap');
  await page.getByRole('button', { name: 'Erneut laden', exact: true }).click();
  await mapIs(page, () => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    return map.loaded() && map.isSourceLoaded('online-opentopomap') && map.areTilesLoaded();
  });
  await chooseBasemap(page, 'street');
  assert.equal(await page.getByRole('alert').count(), 0);

  // Radrouten: an online overlay in Rad-Infos that reports and retries its own failures.
  failing.add('waymarkedtrails');
  const cycling = page.getByRole('button', { name: /^Rad-Infos/ });
  await cycling.click();
  await page.getByLabel('Radrouten').check();
  await page.getByText('Radrouten konnten nicht geladen werden.').waitFor();
  failing.delete('waymarkedtrails');
  await page.locator('.cycling-controls').getByRole('button', { name: 'Erneut laden', exact: true }).click();
  await mapIs(page, () => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    return map.getLayoutProperty('cycling-routes', 'visibility') === 'visible' && map.isSourceLoaded('cycling-routes') && map.areTilesLoaded();
  });
  assert.equal(await page.getByText('Radrouten konnten nicht geladen werden.').count(), 0);
  assert.ok(tiles.waymarkedtrails > 0, 'Radrouten loads its tiles');
  await closeMenus(page);
  // The credits show in one line; the full list, with every provider, opens from it.
  await page.getByRole('button', { name: 'Datenquellen', exact: true }).click();
  await page.locator('.maplibregl-ctrl-attrib a[href="https://cycling.waymarkedtrails.org"]').first().waitFor({ state: 'visible' });
  await page.locator('.cycling-controls .map-menu__trigger').click();
  await page.getByLabel('Radrouten').uncheck();
  await closeMenus(page);
  await page.locator('.sidebar__credits a[href="https://cycling.waymarkedtrails.org"]').waitFor({ state: 'detached' });

  await page.setViewportSize({ width: 390, height: 844 });
  await chooseBasemap(page, 'opentopomap');
  await page.waitForFunction(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.loaded());
  await page.locator('.maplibregl-ctrl-attrib a[href="https://opentopomap.org"]').first().waitFor({ state: 'visible' });
  await page.locator('.maplibregl-ctrl-attrib a[href="https://www.openstreetmap.org/copyright"]').first().waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${output}/mobile.png` });

  // Without the local style, online maps still work; the local map returns after a retry.
  await page.route('**/maps/style.json', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.reload();
  await page.getByRole('alert').filter({ hasText: 'Lokale Straßenkarte' }).waitFor();
  await mapIs(page, () => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    return map.loaded() && map.getLayoutProperty('online-opentopomap', 'visibility') === 'visible' && map.areTilesLoaded();
  });
  await page.unroute('**/maps/style.json');
  await page.getByRole('button', { name: 'Erneut laden', exact: true }).click();
  await mapIs(page, () => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    return map.loaded() && map.getSource('basemap-vector-europe') && map.getGlyphs()?.includes('/maps/fonts/');
  });
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(`${output}/report.json`, JSON.stringify({ states, errors }, null, 2));
  console.log('Online maps: fixture-tested OpenTopoMap and Radrouten, visible provider credits, route preservation, overlays, retry, persistence and mobile attribution passed.');
} finally { await browser.close(); }

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
import { chooseBasemap } from './browser-ui.mjs';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const output = '.cache/online-maps';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(origin) && request.url().startsWith('http')) external.push(request.url()); });
  // Public OSM tiles prohibit automated pan/zoom tests; validate the integration with a fixture.
  const fixture = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e8eadc'; ctx.fillRect(0, 0, 256, 256);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ contentType: 'image/png', body: fixture }));
  await page.addInitScript(() => {
    if (!localStorage.getItem('richiroute.review-basemap')) localStorage.setItem('richiroute.review-basemap', 'street');
  });
  await page.goto(origin);
  await page.waitForFunction(() => {
    const map = document.querySelector('.gpx-reference-layer')?.__vueParentComponent.props.map;
    return map?.getLayer('roads') && map.loaded();
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
  for (const mode of ['liberty', 'bright', 'positron', 'dark', 'osm', 'street']) {
    await chooseBasemap(page, mode);
    await page.waitForFunction(mode => {
      const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
      const layers = map.getStyle().layers;
      const labels = layers.filter(layer => layer.type === 'symbol' && layer.id.startsWith(`online-${mode}-`));
      return map.loaded() && (mode === 'street' ? !layers.some(layer => layer.id.startsWith('online-'))
        : mode === 'osm' ? layers.some(layer => layer.id.startsWith('online-osm-'))
          : labels.length && map.queryRenderedFeatures({ layers: labels.map(layer => layer.id) }).length > 0);
    }, mode, { timeout: 60000 });
    assert.equal(await page.getByRole('alert').count(), 0, `${mode}: ${JSON.stringify(await page.evaluate(() => window.onlineMapErrors))}`);
    const state = await page.evaluate(mode => {
      const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
      const layers = map.getStyle().layers;
      const labels = layers.filter(layer => layer.type === 'symbol' && layer.id.startsWith(`online-${mode}-`));
      return { mode, sourceIds: Object.keys(map.getStyle().sources).filter(id => id.startsWith('online-')),
        labels: labels.length ? map.queryRenderedFeatures({ layers: labels.map(layer => layer.id) }).length : 0,
        waterVisible: map.getLayoutProperty('cycling-water', 'visibility'),
        localGlyphs: map.getGlyphs()?.includes('/maps/fonts/') };
    }, mode);
    if (!['osm', 'street'].includes(mode)) assert.ok(state.labels > 0, `${mode} renders real street/place labels`);
    assert.equal(state.waterVisible, 'visible');
    assert.equal(await page.evaluate(async () => JSON.stringify(await document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getSource('segments-source').getData())), geometry);
    assert.ok(await page.evaluate(() => {
      const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
      const layers = map.getStyle().layers.filter(layer => 'source' in layer && layer.source === 'segments-source' && layer.type === 'line');
      return map.queryRenderedFeatures({ layers: layers.map(layer => layer.id) }).length;
    }), `${mode}: route remains visible`);
    if (mode === 'street') assert.equal(state.localGlyphs, true, 'Local font source is restored');
    states.push(state);
    await page.screenshot({ path: `${output}/${mode}.png` });
  }
  await page.route('https://tiles.openfreemap.org/styles/liberty', route => route.abort());
  await page.evaluate(() => localStorage.setItem('richiroute.review-basemap', 'liberty'));
  await page.reload();
  await page.getByRole('alert').filter({ hasText: 'OpenFreeMap Liberty' }).waitFor();
  await page.unroute('https://tiles.openfreemap.org/styles/liberty');
  await page.getByRole('button', { name: 'Erneut laden', exact: true }).click();
  await page.waitForFunction(() => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    return map?.loaded() && map.getStyle().layers.some(layer => layer.id.startsWith('online-liberty-'));
  }, null, { timeout: 60000 });
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.route('https://tiles.openfreemap.org/planet', route => route.abort());
  await page.reload();
  await page.getByRole('alert').filter({ hasText: 'OpenFreeMap Liberty' }).waitFor();
  await page.unroute('https://tiles.openfreemap.org/planet');
  await page.getByRole('button', { name: 'Erneut laden', exact: true }).click();
  await page.waitForFunction(() => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    const labels = map.getStyle().layers.filter(layer => layer.type === 'symbol' && layer.id.startsWith('online-liberty-'));
    return map.loaded() && labels.length && map.queryRenderedFeatures({ layers: labels.map(layer => layer.id) }).length;
  }, null, { timeout: 60000 });
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseBasemap(page, 'osm');
  await page.waitForFunction(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.loaded());
  await page.locator('.maplibregl-ctrl-attrib a[href="https://www.openstreetmap.org/copyright"]').first().waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${output}/mobile.png` });
  await page.route('**/maps/style.json', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.reload();
  await page.getByRole('alert').filter({ hasText: 'Lokale Straßenkarte' }).waitFor();
  await page.waitForFunction(() => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    return map.loaded() && map.getStyle().layers.some(layer => layer.id.startsWith('online-osm-'));
  }, null, { timeout: 60000 });
  await page.unroute('**/maps/style.json');
  await page.getByRole('button', { name: 'Erneut laden', exact: true }).click();
  await page.waitForFunction(() => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    return map.loaded() && map.getLayer('roads') && map.getGlyphs()?.includes('/maps/fonts/');
  }, null, { timeout: 60000 });
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(`${output}/report.json`, JSON.stringify({ states, errors }, null, 2));
  console.log('Online maps: real OpenFreeMap styles, fixture-tested OSM, route preservation, overlays, retry, persistence and mobile attribution passed.');
} finally { await browser.close(); }

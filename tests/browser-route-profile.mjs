import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const output = '.cache/profile-hover';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true, args: ['--enable-gpu'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
await context.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'local'));
await context.route('**/tiles/**', route => route.fulfill({ status: 200, body: Buffer.alloc(0), contentType: 'application/vnd.mapbox-vector-tile' }));
let requests = 0;
await context.route('**/routing/**', route => { requests++; return route.abort(); });
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const current = () => page.evaluate(() => {
  const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
  const route = stores.get('route'), inspection = stores.get('route-profile');
  return { focus: inspection.focus, distance: inspection.track?.distanceMeters,
    draft: JSON.stringify({ points: route.points, legs: route.legs, undo: route.undoStack, redo: route.redoStack }) };
});
const waitDot = count => page.waitForFunction(async count => {
  const source = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getSource('route-profile-focus');
  return source && (await source.getData()).features.length === count;
}, count);
try {
  await page.goto(origin);
  await page.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();
  await page.evaluate(async () => {
    const { routingPolicyVersion } = await import('/src/config/routing-policy.ts');
    const route = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    const coords = Array.from({ length: 5001 }, (_, i) => [15.4 + i / 500000, 47.1]);
    const points = [coords[0], coords.at(-1), coords[0]].map((coord, i) => ({
      id: String(i), type: 'stop', kind: i === 0 ? 'start' : i === 2 ? 'end' : 'via', coord, address: null, userInput: String(i), isGeocoding: false,
    }));
    const leg = (from, to, coordinates, elevations) => ({ id: `${from}:${to}`, fromId: String(from), toId: String(to),
      fromCoord: points[from].coord, toCoord: points[to].coord, coordinates, elevations,
      distanceMeters: 800, ascentMeters: 100, status: 'routed', surfaces: [], routingPolicy: routingPolicyVersion });
    route.restoreDraft({ version: 1, points, legs: {
      '0:1': leg(0, 1, coords, coords.map((_, i) => 300 + i / 50)),
      '1:2': leg(1, 2, [...coords].reverse(), coords.map((_, i) => 400 - i / 50)),
    } });
  });
  const chart = page.getByRole('slider', { name: 'Position in der Route', exact: true });
  await chart.waitFor();
  await page.getByRole('button', { name: 'Route zeigen', exact: true }).click();
  await chart.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => !document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.isMoving());
  await waitDot(0);
  const before = await current();
  await page.evaluate(() => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    const source = map.getSource('segments-source');
    window.routeGeometryWrites = 0;
    for (const method of ['setData', 'updateData']) {
      const write = source[method].bind(source);
      source[method] = (...args) => { window.routeGeometryWrites++; return write(...args); };
    }
  });
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
  await waitDot(1);
  const outward = (await current()).focus;
  assert.equal(outward.segmentIndex, 0);
  assert.ok(outward.elevation > 340 && outward.elevation < 360);
  assert.match(await chart.getAttribute('aria-valuetext'), /km.*m Höhe.*% Steigung/);
  await page.locator('.profile .elevation-chart__tooltip').waitFor();
  const dot = await page.evaluate(async () => (await document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getSource('route-profile-focus').getData()).features[0].geometry.coordinates);
  assert.deepEqual(dot, outward.coordinate);
  await page.mouse.move(box.x + box.width * .75, box.y + box.height / 2);
  await page.waitForFunction(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route-profile').focus?.segmentIndex === 1);
  assert.ok((await current()).focus.gradient < 0);
  await page.waitForFunction(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.queryRenderedFeatures({ layers: ['route-profile-dot'] }).length > 0);
  await page.screenshot({ path: output + '/desktop.png' });
  assert.equal((await current()).draft, before.draft);
  const basemaps = ['street', 'aerial', 'local'];
  for (const basemap of basemaps) {
    const selected = (await current()).focus;
    await page.getByLabel('Kartenansicht', { exact: true }).selectOption(basemap);
    if (basemap === 'street') await page.waitForFunction(() => document.querySelector('.gpx-reference-layer')
      .__vueParentComponent.props.map.getStyle().layers.some(layer => layer.id.startsWith('basemap-vector-')));
    await waitDot(1);
    assert.deepEqual((await current()).focus, selected, `${basemap} preserves the inspected position`);
    await page.mouse.move(box.x + box.width * .4, box.y + box.height / 2);
    await page.waitForFunction(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.queryRenderedFeatures({ layers: ['route-profile-dot'] }).length > 0);
    assert.equal((await current()).draft, before.draft);
  }
  assert.equal(await page.evaluate(() => window.routeGeometryWrites), 0);
  assert.equal(requests, 0);
  await page.mouse.move(1400, 10); await waitDot(0);
  await chart.focus(); await chart.press('End'); await waitDot(1);
  assert.equal((await current()).focus.distance, before.distance);
  await chart.press('Home');
  assert.deepEqual((await current()).focus.coordinate, [15.4, 47.1]);
  await chart.press('Escape'); await waitDot(0);
  assert.equal(await page.locator('input[type=range]').count(), 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Route zeigen', exact: true }).click();
  await chart.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => !document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.isMoving());
  const mobile = await chart.boundingBox();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mobile.x + mobile.width * .25, y: mobile.y + mobile.height / 2 }] });
  await waitDot(1);
  const first = (await current()).focus.distance;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: mobile.x + mobile.width * .75, y: mobile.y + mobile.height / 2 }] });
  await page.waitForFunction(first => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route-profile').focus?.distance > first, first);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await page.screenshot({ path: output + '/mobile.png' });
  await page.evaluate(() => {
    const route = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    route.legs = { ...route.legs, '0:1': { ...route.legs['0:1'], elevations: null } };
  });
  await waitDot(0);
  await chart.focus(); await chart.press('Home'); await waitDot(1);
  assert.equal((await current()).focus.elevation, null);
  await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').resetRoute());
  await waitDot(0);
  assert.equal(await chart.count(), 0);
  assert.equal(requests, 0); assert.deepEqual(errors, []);
  await writeFile(output + '/report.json', JSON.stringify({ passed: true, points: 10002, requests, routeGeometryWritesDuringHover: 0,
    mouse: true, touch: true, keyboard: true, basemaps, staleFocusCleared: true }, null, 2));
  console.log('Route profile: hover/map dot, out-and-back direction, keyboard, touch, missing heights, stale focus and unchanged route passed.');
} finally { await browser.close(); }

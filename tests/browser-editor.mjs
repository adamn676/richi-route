import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const output = 'experiments/routing/.local';
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }),
  headless: process.env.PLAYWRIGHT_HEADED !== '1', slowMo: Number(process.env.PLAYWRIGHT_SLOW_MO ?? 0) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const tracing = process.env.PLAYWRIGHT_TRACE === '1';
if (tracing) await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage();
const errors = [];
const tiles = { aerial: 0 };
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
  if (response.status() !== 200) return;
  if (response.url().includes('/maps/imagery/')) tiles.aerial++;
});
async function state() {
  return page.evaluate(async () => {
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
    const source = map.getSource('segments-source');
    return { points: s.points, legs: Object.values(s.legs), error: s.errorMessage, distance: s.distanceMeters,
      features: source ? (await source.getData()).features.length : 0,
      hasAir: s.hasAirLines };
  });
}
async function idle() {
  await page.waitForFunction(() => {
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    const source = document.querySelector('.route-layer').__vueParentComponent.props.map.getSource('segments-source');
    return !s.pendingSnapCount && !s.pendingLegCount && (!s.hasAirLines || s.errorMessage) && source?.loaded() !== false;
  }, null, { timeout: 90000 });
}
async function pixel(coord) {
  return page.evaluate(coord => {
    const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
    const p = map.project(coord), box = map.getContainer().getBoundingClientRect();
    return { x: p.x + box.left, y: p.y + box.top };
  }, coord);
}
try {
  await page.goto(process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173/');
  await page.getByRole('button', { name: 'Beispiel: Hahnhofweg → Roseggerweg', exact: true }).click();
  await idle();
  const initial = await state();
  assert.equal(initial.distance, 4371);
  assert.equal(initial.error, null);
  assert.ok(initial.features > 0);
  await page.getByRole('button', { name: 'Route zeigen', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.route-layer').__vueParentComponent.props.map.isMoving());
  await page.waitForFunction(() => document.querySelector('.route-layer').__vueParentComponent.props.map.areTilesLoaded());
  await page.waitForFunction(() => {
    const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
    const ids = map.getStyle().layers.filter(layer => layer.id.startsWith('basemap-vector-') && layer.type === 'line').map(layer => layer.id);
    return ids.length && map.queryRenderedFeatures({ layers: ids }).length > 0;
  });
  await page.screenshot({ path: `${output}/editor-desktop.png` });
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/maps/imagery/') && response.status() === 200),
    page.getByRole('combobox', { name: 'Kartenansicht' }).selectOption('aerial'),
  ]);
  await page.waitForFunction(() => document.querySelector('.route-layer').__vueParentComponent.props.map.areTilesLoaded());
  await page.waitForFunction(() => {
    const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
    const ids = map.getStyle().layers.filter(layer => layer.id.startsWith('basemap-hybrid-') && layer.type === 'symbol').map(layer => layer.id);
    return ids.length && map.queryRenderedFeatures({ layers: ids }).length > 0;
  });
  assert.ok(tiles.aerial > 0, 'Aerial imagery loaded');
  await page.screenshot({ path: `${output}/editor-aerial.png` });

  const coord = initial.legs[0].coordinates[70];
  const p = await pixel(coord);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 12, p.y + 8, { steps: 8 });
  await page.mouse.up();
  await idle();
  const shaped = await state();
  assert.equal(shaped.points.filter(point => point.type === 'shape').length, 1);
  assert.equal(shaped.points.filter(point => point.type === 'stop').length, 2);
  assert.equal(shaped.error, null);
  await page.getByRole('button', { name: 'Rückgängig', exact: false }).click();
  await idle();
  assert.deepEqual((await state()).legs, initial.legs);
  await page.getByRole('button', { name: 'Wiederholen', exact: false }).click();
  await idle();
  assert.deepEqual((await state()).legs, shaped.legs);

  await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').resetRoute([
    [15.4325, 47.0757], [15.416, 47.083], [15.406859, 47.077267], [15.404583, 47.066835], [15.404496, 47.064171],
  ]));
  await idle();
  const western = await state();
  assert.equal(western.error, null);
  await page.getByRole('button', { name: 'Route zeigen', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.route-layer').__vueParentComponent.props.map.isMoving());
  const marker = await page.locator('.route-marker--stop').nth(2).boundingBox();
  await page.mouse.move(marker.x + marker.width / 2, marker.y + marker.height / 2);
  await page.mouse.down();
  await page.mouse.move(marker.x + marker.width / 2 - 20, marker.y + marker.height / 2 + 8, { steps: 8 });
  await page.mouse.up();
  await idle();
  const edited = await state();
  assert.equal(edited.error, null);
  assert.deepEqual(edited.legs[0], western.legs[0]);
  assert.deepEqual(edited.legs[3], western.legs[3]);
  assert.notDeepEqual(edited.points[2].coord, western.points[2].coord);

  // Rider screenshot reproduction: two shapes on Riesstrasse, then the reported left turn.
  await page.evaluate(() => {
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    s.resetRoute([[15.474345, 47.090869], [15.503735, 47.105271]]);
    s.insertShapingPoint(s.points[0].id, s.points[1].id, [15.50514, 47.09081]);
    s.insertShapingPoint(s.points[1].id, s.points[2].id, [15.52183, 47.09573]);
  });
  await idle();
  const junction = await state();
  assert.equal(junction.error, null);
  assert.equal(junction.distance, 9867);
  assert.equal(junction.points.filter(point => point.type === 'shape').length, 2);
  assert.ok(Math.max(...junction.legs.flatMap(leg => leg.coordinates.map(point => point[0]))) < 15.5401);
  await page.evaluate(() => document.querySelector('.route-layer').__vueParentComponent.props.map.jumpTo({ center: [15.539841, 47.103009], zoom: 17.5 }));
  await page.waitForFunction(() => document.querySelector('.route-layer').__vueParentComponent.props.map.areTilesLoaded());
  await page.screenshot({ path: `${output}/editor-junction-corrected.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${output}/editor-mobile.png` });

  // Failed imagery must not hide routes or prevent switching to local roads.
  await page.route('https://maps.wien.gv.at/**', route => route.abort());
  await page.reload();
  await idle();
  await page.waitForFunction(async () => {
    const source = document.querySelector('.route-layer')?.__vueParentComponent.props.map.getSource('segments-source');
    return source && (await source.getData()).features.length > 0;
  });
  assert.equal((await state()).distance, junction.distance);
  assert.deepEqual((await state()).points.map(p => p.coord), junction.points.map(p => p.coord));
  assert.ok((await state()).features > 0);
  await page.getByRole('combobox', { name: 'Kartenansicht' }).selectOption('local');
  await page.waitForFunction(() => document.querySelector('.route-layer').__vueParentComponent.props.map.getLayoutProperty('roads', 'visibility') === 'visible');
  assert.equal(errors.length, 0, errors.join('\n'));
  const report = { initialDistance: initial.distance, initialVertices: initial.legs[0].coordinates.length,
    westernDistance: western.distance, westernLegs: western.legs.length, junctionDistance: junction.distance, tiles, errors,
    checks: ['live routing', 'street imagery', 'labelled aerial imagery', 'line drag', 'undo/redo', 'marker drag', 'unchanged distant legs', 'Ries junction bicycle exception', 'mobile overflow', 'route visible with failed imagery', 'local map switch'] };
  await fs.writeFile(`${output}/editor-browser-results.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (tracing) await context.tracing.stop({ path: `${output}/editor-trace.zip` });
  await browser.close();
}

import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
import { openRoute } from './browser-ui.mjs';
import { westernLoop } from './route-examples.ts';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';

const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: process.env.PLAYWRIGHT_HEADED !== '1' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'street'));
const page = await context.newPage();
const errors = [];
const routingRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (new URL(request.url()).pathname === '/routing/brouter') routingRequests.push(request.url());
});
async function idle() {
  await page.waitForFunction(() => {
    const store = document.querySelector('#app').__vue_app__?.config.globalProperties.$pinia._s.get('route');
    return store && !store.pendingSnapCount && !store.pendingLegCount && !store.hasAirLines &&
      ['saved', 'restored'].includes(store.draftStatus);
  }, null, { timeout: 90000 });
}
async function shapeIds() {
  return page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').shapingPoints.map(point => point.id));
}
try {
  await page.goto(origin);
  await openRoute(page, westernLoop.coords, westernLoop.shapeIndices);
  await idle();
  assert.equal(routingRequests.length, 17, 'Nine snaps and eight legs, without repeated requests from action proxies');
  const ids = await shapeIds();
  assert.equal(ids.length, 6);
  assert.equal(await page.locator('.route-marker--shape').count(), 6);
  assert.ok(await page.getByText('Weidweg: kurze Treppen mit Fahrradrampe. Bitte schieben.', { exact: true }).isVisible());
  await page.getByRole('button', { name: 'Auf Route zoomen', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.route-layer').__vueParentComponent.props.map.isMoving());
  await page.screenshot({ path: 'experiments/routing/.local/western-example-editor.png' });
  await page.reload();
  await idle();
  assert.equal(routingRequests.length, 17, 'Restoring a completed draft does not recalculate it');
  assert.deepEqual(await shapeIds(), ids, 'Saved draft retains all shaping points');
  const beforeEdit = routingRequests.length;
  await page.evaluate(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    const point = store.shapingPoints[1];
    store.updateShapingPointCoord(point.id, [point.coord[0], point.coord[1] + 0.00005]);
  });
  await idle();
  assert.equal(routingRequests.length - beforeEdit, 3, 'Editing one point uses one snap and two adjacent legs');
  await page.getByRole('button', { name: /Rückgängig/ }).click();
  await idle();
  assert.equal(routingRequests.length - beforeEdit, 3, 'Undo restores cached geometry');
  await page.getByRole('button', { name: 'Formpunkte entfernen', exact: true }).click();
  await idle();
  assert.deepEqual(await shapeIds(), []);
  await page.getByRole('button', { name: /Rückgängig/ }).click();
  await idle();
  assert.deepEqual(await shapeIds(), ids, 'Undo restores the visible route preferences');
  assert.deepEqual(errors, []);
  console.log('Western example loads, shows six shapes, persists on reload, and restores shapes through undo.');
} finally {
  await browser.close();
}

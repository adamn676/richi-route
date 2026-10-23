import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'local'));
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let release;
let gate;
let failLast = false;
let holdEdits = false;
function hold() { gate = new Promise(resolve => { release = resolve; }); }
await page.route('**/routing/brouter?*', async request => {
  const coords = new URL(request.request().url()).searchParams.get('lonlats').split('|');
  const lastLeg = coords[0] === '15.388014,47.062999' && coords[1] === '15.4329,47.075887';
  const response = await request.fetch();
  if (lastLeg || holdEdits) await gate;
  if (lastLeg && failLast) await request.fulfill({ status: 400, body: 'datafile E5_N45.rd5 not found' });
  else await request.fulfill({ response });
});
const progress = page.getByRole('status').filter({ hasText: 'Route wird berechnet' });
async function settled() {
  await page.waitForFunction(() => {
    const store = document.querySelector('#app').__vue_app__?.config.globalProperties.$pinia._s.get('route');
    return store && store.route && !store.pendingSnapCount && !store.pendingLegCount;
  });
}
async function drawnFeatures() {
  return page.evaluate(() => document.querySelector('.route-layer').__vueParentComponent.props.map
    .getSource('segments-source').serialize().data.features.length);
}
try {
  await page.goto('http://127.0.0.1:5173/');
  for (const failure of [false, true]) {
    failLast = failure;
    hold();
    if (failure) await page.getByRole('button', { name: 'Neue Route', exact: true }).click();
    await page.getByRole('button', { name: /Beispiel: Westliche Runde/ }).click();
    await page.waitForFunction(() => {
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
      return Object.values(store.legs).filter(leg => leg.status === 'routed').length === 7 && store.pendingLegCount === 1;
    });
    assert.ok(await progress.isVisible(), 'Loading is explicit while the last section waits');
    assert.equal(await page.getByText('Gestrichelte Abschnitte warten auf Routing oder haben keine Straßenverbindung.').count(), 0, 'Pending work is not described as a missing road connection');
    assert.equal(await drawnFeatures(), 0, 'No partial initial line is displayed');
    if (!failure) await page.screenshot({ path: 'experiments/routing/.local/initial-route-loading.png' });
    release();
    await settled();
    await page.waitForFunction(() => document.querySelector('.route-layer').__vueParentComponent.props.route !== null);
    assert.equal(await progress.count(), 0);
    assert.ok(await drawnFeatures() > 0, 'Completed or failed route becomes visible');
    if (failure) {
      assert.ok(await page.locator('.planner__error').isVisible());
      assert.match(await page.locator('.planner__error').innerText(), /Kartendaten \(E5_N45\.rd5\)/);
      const airCount = await page.evaluate(() => document.querySelector('.route-layer').__vueParentComponent.props.route.features.filter(f => f.properties.status === 'air').length);
      assert.equal(airCount, 1, 'Failed section remains visibly dashed');
    } else {
      holdEdits = true;
      hold();
      await page.evaluate(() => {
        const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
        const point = store.shapingPoints[1];
        store.updateShapingPointCoord(point.id, [point.coord[0], point.coord[1] + .00005]);
      });
      assert.equal(await progress.count(), 0, 'Editing an existing route does not hide it');
      assert.ok(await drawnFeatures() > 0);
      release();
      await settled();
      holdEdits = false;
    }
  }
  assert.deepEqual(errors, []);
  console.log('Initial route appears together; edits stay visible; failures reveal dashed sections and an error.');
} finally {
  release?.();
  await browser.close();
}

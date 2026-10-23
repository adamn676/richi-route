import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: process.env.PLAYWRIGHT_HEADED !== '1' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'local'));
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const notice = page.getByText('Weidweg: kurze Treppen mit Fahrradrampe. Bitte schieben.', { exact: true });
async function idle() {
  await page.waitForFunction(() => {
    const store = document.querySelector('#app').__vue_app__?.config.globalProperties.$pinia._s.get('route');
    return store && !store.pendingSnapCount && !store.pendingLegCount && !store.hasAirLines && ['saved', 'restored'].includes(store.draftStatus);
  }, null, { timeout: 90000 });
}
try {
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForSelector('.planner');
  await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').resetRoute([[15.397965, 47.103194], [15.397308, 47.102517]]));
  await idle();
  assert.ok(await notice.isVisible());
  await page.getByRole('button', { name: 'Route zeigen', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.route-layer').__vueParentComponent.props.map.isMoving());
  await page.screenshot({ path: 'experiments/routing/.local/weidweg-editor.png' });
  await page.reload();
  await idle();
  assert.ok(await notice.isVisible(), 'Restored geometry retains the push-through notice');
  await page.getByRole('button', { name: 'Neue Route', exact: true }).click();
  await page.waitForFunction(() => !document.body.textContent.includes('Bitte schieben.'));
  assert.deepEqual(errors, []);
  console.log('Editor shows the push-through notice, retains it on restoration, and clears it with the route.');
} finally {
  await browser.close();
}

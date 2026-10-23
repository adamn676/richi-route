import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: process.env.PLAYWRIGHT_HEADED !== '1' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
await context.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'local'));
await context.route('**/tiles/**', route => route.fulfill({ status: 200, contentType: 'application/vnd.mapbox-vector-tile', body: Buffer.alloc(0) }));
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
let requests = 0, hold, release, wrongRevision = false;
await context.route('**/routing/brouter?**', async route => {
  requests++;
  if (hold) await hold;
  const url = new URL(route.request().url());
  if (wrongRevision) url.searchParams.set('profile:richiroute_rules_3', '1');
  await route.continue({ url: url.href });
});
async function idle() {
  await page.waitForFunction(() => {
    const s = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('route');
    return s && !s.pendingSnapCount && !s.pendingLegCount && !s.hasAirLines && ['saved', 'restored'].includes(s.draftStatus);
  }, null, { timeout: 90000 });
}
async function reset() {
  await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route')
    .resetRoute([[15.397965, 47.103194], [15.397308, 47.102517]]));
}
const notice = page.getByText('Weidweg: kurze Treppen mit Fahrradrampe. Bitte schieben.', { exact: true });
try {
  await page.goto('http://127.0.0.1:5173/');
  await page.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();
  await reset(); await idle();
  assert.equal(await notice.count(), 1, 'Two flights produce one rule notice');
  const before = await page.evaluate(() => {
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    const draft = JSON.parse(localStorage.getItem('richiroute.route-draft.v1'));
    for (const leg of Object.values(draft.legs)) leg.routingPolicy = 'old-policy';
    localStorage.setItem('richiroute.route-draft.v1', JSON.stringify(draft));
    return Object.values(s.legs).map(l => l.coordinates);
  });
  hold = new Promise(resolve => { release = resolve; });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('route')?.pendingLegCount > 0);
  await page.waitForFunction(async () => {
    const source = document.querySelector('.route-layer')?.__vueParentComponent.props.map?.getSource('segments-source');
    return source && (await source.getData()).features.length > 0;
  });
  assert.deepEqual(await page.evaluate(() => Object.values(document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').legs).map(l => l.coordinates)), before);
  assert.equal(await notice.count(), 0, 'Outdated geometry does not claim current rule notices');
  assert.ok(await page.getByRole('button', { name: 'GPX herunterladen' }).isDisabled());
  release(); hold = undefined;
  await idle(); assert.ok(await notice.isVisible());
  const afterRefresh = requests;
  await page.reload(); await idle();
  assert.equal(requests, afterRefresh, 'The current policy restores without new routing');
  assert.ok(await notice.isVisible());

  wrongRevision = true;
  await reset();
  await page.getByText('Die lokalen Routing-Regeln wurden geändert. Bitte den Routing-Dienst neu starten.', { exact: true }).first().waitFor();
  assert.equal(await notice.count(), 0);
  wrongRevision = false;
  await page.getByRole('button', { name: 'Erneut versuchen', exact: true }).click();
  await idle(); assert.ok(await notice.isVisible());
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'experiments/routing/.local/local-routing-rules/browser-local-rules.png' });
  await writeFile('experiments/routing/.local/local-routing-rules/browser-local-rules.json', JSON.stringify({ browser: browser.version(), requests,
    checks: ['shared notice and deduplication', 'visible saved geometry during policy refresh', 'stale notices suppressed', 'current policy restores without requests', 'real engine revision mismatch', 'retry recovery'], pageErrors: errors }, null, 2));
  console.log('Local rules: notices, stale-route refresh, visible geometry, revision rejection and retry passed.');
} finally {
  release?.();
  await context.tracing.stop({ path: 'experiments/routing/.local/local-routing-rules/browser-local-rules-trace.zip' });
  await browser.close();
}

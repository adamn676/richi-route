import assert from 'node:assert/strict';
import { chromium } from '../../../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const runId = process.argv[2];
const caseId = process.argv.find(arg => arg.startsWith('--case='))?.slice(7) ?? '07-south-quiet';
const variant = process.argv.find(arg => arg.startsWith('--variant='))?.slice(10) ?? 'automatic';
const variantLabel = { automatic: 'Automatic', selected: 'Chosen roads', edited: 'After an edit' }[variant];
assert.ok(variantLabel, 'Pass a supported route variant.');
assert.ok(runId, 'Pass a saved frozen evaluation run ID.');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors = [];
  const tiles = new Set();
  const imagery = { street: 0, aerial: 0, labels: 0 };
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.ok() && response.url().includes('/tiles/')) tiles.add(response.url());
    if (response.ok()) {
      for (const [name, layer] of Object.entries({ street: 'geolandbasemap', aerial: 'bmaporthofoto30cm', labels: 'bmapoverlay' })) {
        if (response.url().includes(`/basemap/${layer}/`)) imagery[name]++;
      }
    }
  });
  await page.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'local'));
  const link = `http://127.0.0.1:5174/?case=${caseId}&variant=${variant}&run=${runId}`;
  await page.goto(link, { waitUntil: 'networkidle' });
  const run = await (await page.request.get(`http://127.0.0.1:5174/api/run?id=${runId}`)).json();
  assert.ok(run.evaluationFreeze);
  assert.equal(await page.getByLabel('Scenario set').inputValue(), 'evaluation');
  assert.equal(await page.getByRole('button', { name: variantLabel, exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('tbody tr').count(), 3);
  const scenario = run.scenarios.find(item => item.id === caseId);
  const pointCount = variant === 'automatic' ? scenario.points.filter(point => point.role === 'stop').length : scenario.points.length;
  assert.equal(await page.locator('.route-point').count(), pointCount);
  assert.equal(await page.getByLabel('Include local OpenRouteService').isDisabled(), true);
  await page.getByText('Comparison setup', { exact: true }).click();
  await page.getByText('Settings fixed for this evaluation.', { exact: false }).waitFor();
  assert.ok(tiles.size > 0, 'Local road tiles loaded.');
  assert.equal(await page.locator('.map-error').count(), 0);
  await page.route('**/api/run', async request => {
    const payload = request.request().postDataJSON();
    assert.equal(payload.settings, run.settings);
    assert.equal(payload.evaluationFreeze, run.evaluationFreeze);
    assert.equal(payload.includeOrs, true);
    await request.fulfill({ json: run });
  });
  await page.getByRole('button', { name: 'Compare routes', exact: true }).click();
  await page.getByText('Comparison saved. Select a route to review it.', { exact: true }).waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getByLabel('Saved comparison').inputValue(), runId);
  assert.equal(await page.getByRole('button', { name: variantLabel, exact: true }).getAttribute('aria-pressed'), 'true');
  if (process.argv.includes('--imagery')) {
    await page.getByRole('button', { name: 'Street map', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.map-loading'), null, { timeout: 30000 });
    await page.getByRole('button', { name: 'Aerial + labels', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.map-loading'), null, { timeout: 30000 });
    assert.ok(Object.values(imagery).every(count => count > 0), 'Street map, aerial imagery and labels loaded.');
    assert.equal(await page.locator('.map-error').count(), 0);
  }
  await page.screenshot({ path: `experiments/routing/.local/evaluation-${caseId}-${variant}.png`, fullPage: true });
  const nextDifference = page.getByRole('button', { name: /Next difference/ });
  if (await nextDifference.isEnabled()) {
    await nextDifference.click();
    await page.waitForFunction(() => document.querySelector('.map-canvas').__vueParentComponent.setupState.map.loaded());
    await page.screenshot({ path: `experiments/routing/.local/evaluation-${caseId}-${variant}-difference.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ link, localRoadTiles: tiles.size, imagery, errors }));
} finally {
  await browser.close();
}

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const output = fileURLToPath(new URL('../browser-artifacts/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  const errors = [];
  const successfulTiles = new Set();
  const externalHosts = new Set();
  const pending = new Set();
  let lastNetworkChange = Date.now();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    pending.add(request);
    lastNetworkChange = Date.now();
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1') externalHosts.add(url.hostname);
  });
  for (const event of ['requestfinished', 'requestfailed']) page.on(event, (request) => {
    pending.delete(request);
    lastNetworkChange = Date.now();
  });
  async function settleMap() {
    const deadline = Date.now() + 15000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (pending.size === 0 && Date.now() - lastNetworkChange > 700) return;
    } while (Date.now() < deadline);
    throw new Error(`Map requests did not finish: ${[...pending].map(request => request.url()).join(', ')}`);
  }
  page.on('response', (response) => {
    if (response.url().includes('maps.wien.gv.at/basemap/') && response.ok()) successfulTiles.add(response.url());
  });
  await page.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle' });
  await page.locator('.route-choice').first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Street map', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.ok([...successfulTiles].some((url) => url.includes('/geolandbasemap/')), 'Street tiles must actually load.');
  await page.screenshot({ path: `${output}/mur-automatic-street.png`, fullPage: true });
  const map = page.locator('.map-canvas');
  const box = await map.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await settleMap();
  await page.screenshot({ path: `${output}/street-detail.png`, fullPage: true });
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/bmaporthofoto30cm/') && response.ok()),
    page.waitForResponse((response) => response.url().includes('/bmapoverlay/') && response.ok()),
    page.getByRole('button', { name: 'Aerial + labels', exact: true }).click(),
  ]);
  await settleMap();
  assert.ok([...successfulTiles].some((url) => url.includes('/bmapoverlay/')), 'Aerial label tiles must actually load.');
  assert.equal(await page.locator('.route-point').count(), 2);
  await page.getByLabel('Route opacity').fill('0.3');
  await page.screenshot({ path: `${output}/aerial-detail.png`, fullPage: true });
  for (const offset of [0, -30, 30, -60, 60, -90, 90]) {
    await page.mouse.click(box.x + box.width / 2 + offset, box.y + box.height / 2);
    if (await page.locator('.road-detail').count()) break;
  }
  assert.equal(await page.locator('.road-detail').count(), 1, 'Clicking a road should show its local routing attributes.');
  assert.match(await page.locator('.road-detail').innerText(), /Surface[\s\S]*Smoothness[\s\S]*Bicycle access tag/);
  await page.screenshot({ path: `${output}/road-inspection.png`, fullPage: true });
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getByRole('button', { name: 'Aerial + labels', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Local roads', exact: true }).click();
  await page.waitForLoadState('networkidle');
  const localPage = await browser.newPage();
  const localRequests = [];
  await localPage.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'local'));
  localPage.on('request', (request) => { if (request.url().startsWith('https://')) localRequests.push(request.url()); });
  await localPage.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle' });
  assert.deepEqual(localRequests, []);
  await localPage.close();
  await page.getByLabel('Road-cycling scenario').selectOption('03-eggenberg-junction');
  await page.getByText('Scenario notes & method', { exact: true }).click();
  await page.locator('.revision-note').filter({ hasText: 'Scenario revision 2' }).waitFor();
  await page.getByRole('button', { name: 'Street map', exact: true }).click();
  await settleMap();
  await page.screenshot({ path: `${output}/eggenberg-automatic.png`, fullPage: true });
  await page.getByRole('button', { name: 'Chosen roads', exact: true }).click();
  await settleMap();
  assert.equal(await page.locator('.route-point').count(), 6);
  await page.screenshot({ path: `${output}/eggenberg-chosen-roads.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Street map', exact: true }).click();
  await settleMap();
  await page.screenshot({ path: `${output}/street-mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual([...externalHosts], ['maps.wien.gv.at']);
  assert.deepEqual(errors, []);
  const unavailable = await browser.newPage();
  await unavailable.route('https://maps.wien.gv.at/**', (route) => route.abort());
  await unavailable.goto('http://127.0.0.1:5174/');
  await unavailable.getByText('Online map tiles could not load.', { exact: false }).waitFor();
  await unavailable.getByRole('button', { name: 'Local roads', exact: true }).click();
  assert.equal(await unavailable.locator('.map-error').count(), 0);
  await unavailable.close();
  const roadFailure = await browser.newPage();
  await roadFailure.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'local'));
  let blockRoadTiles = true;
  await roadFailure.route('**/tiles/**', (route) => blockRoadTiles ? route.fulfill({ status: 503, body: 'Simulated tile failure' }) : route.continue());
  await roadFailure.goto('http://127.0.0.1:5174/');
  await roadFailure.getByText('The local road service is running, but some road details could not load.', { exact: false }).waitFor();
  assert.doesNotMatch(await roadFailure.locator('.map-error').innerText(), /bench:up/);
  await roadFailure.locator('.route-choice').first().waitFor();
  const routeRows = await roadFailure.locator('tbody tr').count();
  blockRoadTiles = false;
  await Promise.all([
    roadFailure.waitForResponse((response) => response.url().includes('/tiles/') && response.ok()),
    roadFailure.getByRole('button', { name: 'Retry map', exact: true }).click(),
  ]);
  await roadFailure.waitForLoadState('networkidle');
  assert.equal(await roadFailure.locator('.map-error').count(), 0);
  assert.equal(await roadFailure.locator('tbody tr').count(), routeRows);
  assert.equal(await roadFailure.locator('.route-point').count(), 2);

  // Simulate an unavailable service without stopping the user's engines.
  blockRoadTiles = true;
  await roadFailure.route('**/api/map-status', (route) => route.fulfill({ json: { available: false } }));
  await roadFailure.reload();
  await roadFailure.getByText('The local road service is not responding.', { exact: false }).waitFor();
  assert.match(await roadFailure.locator('.map-error').innerText(), /bench:up/);

  // A late health check must not restore a warning after a successful retry.
  await roadFailure.unroute('**/api/map-status');
  let releaseStatus;
  let statusRequested;
  const statusRequest = new Promise((resolve) => { statusRequested = resolve; });
  const statusRelease = new Promise((resolve) => { releaseStatus = resolve; });
  let statusFinished;
  const statusDone = new Promise((resolve) => { statusFinished = resolve; });
  await roadFailure.route('**/api/map-status', async (route) => {
    statusRequested();
    await statusRelease;
    await route.fulfill({ json: { available: false } });
    statusFinished();
  });
  await roadFailure.reload();
  await statusRequest;
  await roadFailure.getByRole('button', { name: 'Retry map', exact: true }).waitFor();
  blockRoadTiles = false;
  await Promise.all([
    roadFailure.waitForResponse((response) => response.url().includes('/tiles/') && response.ok()),
    roadFailure.getByRole('button', { name: 'Retry map', exact: true }).click(),
  ]);
  releaseStatus();
  await statusDone;
  await roadFailure.waitForLoadState('networkidle');
  assert.equal(await roadFailure.locator('.map-error').count(), 0);
  await roadFailure.close();
  console.log(`Basemap checks passed: ${successfulTiles.size} street/aerial/label tiles, road-detail popup, mode persistence, route retention, opacity, offline mode, unavailable-provider fallback, mobile layout, and only the free basemap.at host.`);
  console.log('Road-detail recovery checks passed: reachable service, unavailable service, retry with routes retained, and late health response ignored.');
} finally { await browser.close(); }

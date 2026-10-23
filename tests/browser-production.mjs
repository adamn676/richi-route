import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

// Run npm run build, then npm run preview -- --host 127.0.0.1 --port 5175.
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }),
  headless: process.env.PLAYWRIGHT_HEADED !== '1' });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'local'));
  await context.route('**/tiles/**', route => route.fulfill({ status: 200,
    contentType: 'application/vnd.mapbox-vector-tile', body: Buffer.alloc(0) }));
  const page = await context.newPage();
  const errors = [], workers = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('worker', worker => workers.push(worker.url()));
  await page.goto('http://127.0.0.1:5175/');
  await page.getByRole('button', { name: 'Beispiel: Hahnhofweg → Roseggerweg', exact: true }).click();
  await page.waitForFunction(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    return !store.pendingSnapCount && !store.pendingLegCount && store.draftStatus === 'saved';
  }, null, { timeout: 90000 });
  const result = await page.evaluate(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    return { distanceMeters: store.distanceMeters, error: store.errorMessage, complete: !store.hasAirLines,
      webgl2: document.querySelector('.maplibregl-canvas').getContext('webgl2') instanceof WebGL2RenderingContext };
  });
  assert.deepEqual(result, { distanceMeters: 4371, error: null, complete: true, webgl2: true });
  assert.ok(workers.some(url => /\/assets\/maplibre-gl-worker-[\w-]+\.js$/.test(url)), 'Production map worker loads as a built asset');
  await page.getByRole('button', { name: 'Route zeigen', exact: true }).click();
  await page.waitForFunction(() => {
    const bounds = document.querySelector('.maplibregl-canvas').getBoundingClientRect();
    const markers = [...document.querySelectorAll('.route-marker--stop')];
    return markers.length === 2 && markers.every(marker => {
      const box = marker.getBoundingClientRect();
      return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
    });
  });
  await page.screenshot({ path: 'experiments/routing/.local/production-editor.png' });
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'GPX herunterladen', exact: true }).click();
  const gpx = await readFile(await (await downloadEvent).path(), 'utf8');
  assert.match(gpx, /<trkpt lat="/);
  assert.match(gpx, /<ele>/);
  assert.deepEqual(errors, []);
  await writeFile('experiments/routing/.local/production-browser.json', JSON.stringify({ ...result, workers, errors }, null, 2));
  console.log('Production worker, WebGL2 map, live routing, draft save and GPX export passed.');
} finally { await browser.close(); }

import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const label = process.env.IMAGERY_BENCH_LABEL ?? 'current';
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true, args: ['--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const results = [];
let requests = [], start;
page.on('response', response => {
  if (response.url().includes('/maps/imagery/') && response.status() === 200 && start) {
    requests.push({ ms: Math.round(performance.now() - start), cache: response.headers()['x-imagery-cache'],
      sources: response.headers()['x-imagery-sources'], degraded: response.headers()['x-imagery-degraded'] });
  }
});
async function measure(name, positions) {
  requests = []; start = performance.now();
  for (const position of positions) {
    await page.evaluate(position => {
      const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
      window.imageryViewIdle = false; map.once('idle', () => { window.imageryViewIdle = true; });
      map.jumpTo(position);
    }, position);
    if (positions.length > 1) await page.waitForTimeout(150);
  }
  const finalView = performance.now();
  await page.waitForFunction(() => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    return window.imageryViewIdle && map.areTilesLoaded() && map.isSourceLoaded('basemap-aerial');
  }, {}, { timeout: 90000 });
  const result = { name, completeMs: Math.round(performance.now() - finalView), requests: [...requests] };
  results.push(result);
  console.log(JSON.stringify({ name, completeMs: result.completeMs, tiles: requests.length,
    misses: requests.filter(r => r.cache === 'miss').length, degraded: requests.filter(r => r.degraded === '1').length }));
  start = undefined;
}
try {
  await page.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'aerial'));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('.gpx-reference-layer')?.__vueParentComponent.props.map.getLayer('roads'), {}, { timeout: 90000 });
  await measure('graz-detail', [{ center: [15.47, 47.08], zoom: 17 }]);
  await measure('graz-pan', [{ center: [15.48, 47.08], zoom: 17 }]);
  await measure('graz-zoom-and-pan', [
    { center: [15.46, 47.09], zoom: 13 }, { center: [15.47, 47.085], zoom: 14 },
    { center: [15.48, 47.08], zoom: 15 }, { center: [15.49, 47.075], zoom: 16 },
    { center: [15.50, 47.07], zoom: 17 }, { center: [15.51, 47.065], zoom: 18 },
  ]);
  await measure('graz-cached-return', [{ center: [15.47, 47.08], zoom: 17 }]);
  await mkdir('.cache/imagery-performance', { recursive: true });
  await writeFile(`.cache/imagery-performance/${label}.json`, JSON.stringify(results, null, 2));
} finally { await browser.close(); }

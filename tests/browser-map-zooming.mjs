import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chooseBasemap } from './browser-ui.mjs';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5176';
const label = process.env.MAP_ZOOM_LABEL ?? 'baseline';
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await page.addInitScript(() => {
    localStorage.setItem('richiroute.review-basemap', 'street');
    localStorage.setItem('richiroute.cycling-overlays', '[]');
  });
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('.gpx-reference-layer')?.__vueParentComponent.props.map.getSource('basemap-vector-europe'));
  const results = [];
  let requested = 0, cancelled = 0, degraded = 0;
  page.on('request', request => { if (/\/maps\/imagery(?:-fast)?\//.test(request.url())) requested++; });
  page.on('requestfailed', request => { if (/\/maps\/imagery(?:-fast)?\//.test(request.url())) cancelled++; });
  page.on('response', response => { if (response.headers()['x-imagery-degraded'] === '1') degraded++; });
  for (const [place, center, mode] of [
    ['Graz', [15.398, 47.095], 'aerial'],
    ['Virgen', [12.453, 47.002], 'aerial'],
    ['Graz detail', [15.398, 47.095], 'aerial'],
  ]) {
    requested = 0; cancelled = 0; degraded = 0;
    await chooseBasemap(page, 'street');
    await page.evaluate(center => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.jumpTo({ center, zoom: 13 }), center);
    const started = performance.now();
    await chooseBasemap(page, mode);
    const settleMs = await page.evaluate(async () => {
      const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
      for (const zoom of [15, 17, 19]) {
        await new Promise(resolve => { map.once('moveend', resolve); map.easeTo({ zoom, duration: 300, essential: true }); });
      }
      const started = performance.now();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Imagery did not settle')), 90000);
        map.once('idle', () => { clearTimeout(timeout); resolve(); });
        map.triggerRepaint();
      });
      return Math.round(performance.now() - started);
    });
    const result = { place, totalMs: Math.round(performance.now() - started), settleMs, requested, cancelled, degraded };
    results.push(result); console.log(result);
  }
  await mkdir('.cache/map-speed-dive', { recursive: true });
  await writeFile(`.cache/map-speed-dive/${label}.json`, JSON.stringify(results, null, 2));
} finally { await browser.close(); }

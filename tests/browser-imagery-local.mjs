import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const saved = process.env.IMAGERY_EXPECT_SAVED === '1';
const label = saved ? 'saved' : 'upstream';
const output = '.cache/imagery-local';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true, args: ['--enable-gpu'] });
const report = [];
try {
  for (const density of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: density });
    const page = await context.newPage();
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) external.push(url.href);
    });
    await page.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'aerial'));
    await page.goto(origin);
    await page.waitForFunction(() => {
      const map = document.querySelector('.route-layer')?.__vueParentComponent.props.map;
      return map?.getSource('basemap-vector-europe') && map.areTilesLoaded();
    }, {}, { timeout: 90000 });
    let requests = [];
    page.on('response', response => {
      const match = /\/maps\/imagery\/(\d+)\//.exec(response.url());
      if (match && Number(match[1]) >= 19 && response.status() === 200) requests.push({ z: Number(match[1]),
        sources: response.headers()['x-imagery-sources'], degraded: response.headers()['x-imagery-degraded'] });
    });
    for (const [name, center] of [['detail', [15.438, 47.071]], ['pan', [15.441, 47.071]]]) {
      requests = [];
      const start = performance.now();
      await page.evaluate(center => document.querySelector('.route-layer').__vueParentComponent.props.map.jumpTo({ center, zoom: 18 }), center);
      await page.waitForFunction(() => {
        const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
        return map.areTilesLoaded() && map.isSourceLoaded('basemap-aerial');
      }, {}, { timeout: 90000 });
      const milliseconds = Math.round(performance.now() - start);
      assert.ok(requests.length > 0, 'The new view requests imagery');
      assert.equal(Math.max(...requests.map(r => r.z)), density === 2 ? 20 : 19);
      assert.ok(requests.every(r => r.degraded === '0'));
      if (saved) assert.ok(requests.every(r => r.sources === 'saved-region'), 'All detail comes from saved tiles');
      const result = { density, name, milliseconds, tiles: requests.length, sources: [...new Set(requests.map(r => r.sources))] };
      report.push(result); console.log(result);
      if (name === 'detail') await page.screenshot({ path: `${output}/${label}-${density}x.png` });
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await context.close();
  }
  await writeFile(`${output}/${label}.json`, JSON.stringify(report, null, 2));
} finally { await browser.close(); }

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
import { tilePoint } from '../scripts/imagery/regions.mjs';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const offline = process.env.RICHIROUTE_IMAGERY_OFFLINE === '1';
const output = '.cache/imagery-review';
await mkdir(output, { recursive: true });
const report = [];
async function tile(lon, lat, z, expected) {
  const [x, y] = tilePoint(lon, lat, z).map(Math.floor);
  const url = `${origin}/maps/imagery/${z}/${x}/${y}.jpg`;
  const started = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
  assert.equal(response.status, 200, url);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  const data = Buffer.from(await response.arrayBuffer());
  assert.equal(data[0], 255); assert.equal(data[1], 216);
  const sources = response.headers.get('x-imagery-sources');
  assert.ok(sources.split(',').includes(expected), `${url}: ${sources} should contain ${expected}`);
  const record = { lon, lat, z, sources, milliseconds: Math.round(performance.now() - started),
    degraded: response.headers.get('x-imagery-degraded'), bytes: data.length };
  report.push(record); console.log(record);
  if (!offline) assert.equal(record.degraded, '0', 'Online coverage uses complete imagery');
  await writeFile(`${output}/tile-${z}-${x}-${y}.jpg`, data);
  const cached = await fetch(url, { headers: { 'If-None-Match': response.headers.get('etag') } });
  assert.equal(cached.status, 304);
}
if (offline) {
  await tile(15.4395, 47.0707, 16, 'saved-region');
  await tile(13.405, 52.52, 7, 'sentinel-overview');
  await tile(-3.704, 40.416, 19, 'sentinel-overview');
} else {
  await tile(15.43, 47.115, 16, 'AT-GRAZ');
  await tile(15.65, 47.0707, 16, 'AT-STYRIA');
  await tile(8.5417, 47.3769, 16, 'CHE');
  await tile(2.3522, 48.8566, 16, 'FRA');
  await tile(13.405, 52.52, 7, 'sentinel-overview');
  await tile(13.405, 52.52, 13, 'sentinel');
  await tile(-3.704, 40.416, 13, 'sentinel');
  await tile(6.142, 46.213, 10, 'CHE');
  assert.ok(report.at(-1).sources.includes('FRA'), 'A Geneva border tile includes both national providers');
}
for (const suffix of ['21/0/0.jpg', '2/4/0.jpg', '2/0/4.jpg']) {
  assert.equal((await fetch(`${origin}/maps/imagery/${suffix}`)).status, 404);
}
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const external = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) {
      external.push(url.href); return route.abort();
    }
    return route.continue();
  });
  await page.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'aerial'));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('.route-layer')?.__vueParentComponent.props.map.getLayer('basemap-hybrid-road'));
  for (const [name, center, zoom] of offline ? [['graz-offline', [15.4395, 47.0707], 16]]
    : [['europe', [10, 52], 4], ['graz', [15.4395, 47.0707], 16], ['zurich', [8.5417, 47.3769], 16], ['paris', [2.3522, 48.8566], 16], ['berlin', [13.405, 52.52], 12]]) {
    await page.evaluate(({ center, zoom }) => document.querySelector('.route-layer').__vueParentComponent.props.map.jumpTo({ center, zoom }), { center, zoom });
    await page.waitForFunction(() => {
      const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
      return map.areTilesLoaded() && map.isSourceLoaded('basemap-aerial');
    }, {}, { timeout: 120000 });
    assert.match(await page.locator('.maplibregl-ctrl-attrib').textContent(), /Copernicus Sentinel data 2026/);
    if (zoom >= 16) {
      const count = await page.evaluate(() => {
        const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
        return map.queryRenderedFeatures({ layers: map.getStyle().layers.filter(layer => layer.id.startsWith('basemap-hybrid-roads_labels_')).map(layer => layer.id) }).length;
      });
      assert.ok(count > 0, `${name} has local street labels`);
    }
    await page.screenshot({ path: `${output}/${name}.png` });
  }
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  await writeFile(`${output}/report${offline ? '-offline' : ''}.json`, JSON.stringify({ tiles: report, external, errors }, null, 2));
  console.log('European imagery, local street labels and browser independence passed.');
} finally { await browser.close(); }

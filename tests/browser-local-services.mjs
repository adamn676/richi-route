import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const output = '.cache/local-services';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const external = [], errors = [], results = [];
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) {
    external.push(url.href); return route.abort();
  }
  return route.continue();
});
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('.route-layer')?.__vueParentComponent.props.map.getSource('basemap-vector-europe'));
  for (const [name, center] of [
    ['Graz', [15.44, 47.07]], ['München', [11.58, 48.14]], ['Paris', [2.35, 48.85]], ['Berlin', [13.4, 52.52]],
    ['Madrid', [-3.7, 40.42]], ['Oslo', [10.75, 59.91]], ['Dublin', [-6.26, 53.35]],
    ['Rom', [12.5, 41.9]], ['Warszawa', [21.01, 52.23]],
  ]) {
    const result = await page.evaluate(async ({ name, center }) => {
      const start = performance.now();
      const response = await fetch(`/geocoding/api/?${new URLSearchParams({ q: name, lang: 'de', limit: '8' })}`);
      if (!response.ok) throw new Error(`Local search: HTTP ${response.status}`);
      const data = await response.json();
      const searchMs = Math.round(performance.now() - start);
      const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
      map.jumpTo({ center, zoom: 13 });
      return { name, searchMs, features: data.features };
    }, { name, center });
    // the address search covers the routing area (5–20° E, 45–50° N); the maps all of Europe
    const searched = center[0] >= 5 && center[0] <= 20 && center[1] >= 45 && center[1] <= 50;
    assert.ok(!searched || result.features.some(feature => Math.abs(feature.geometry.coordinates[0] - center[0]) < .5
      && Math.abs(feature.geometry.coordinates[1] - center[1]) < .5), `${name}: a matching local search result`);
    await page.waitForFunction(() => {
      const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
      const layers = map.getStyle().layers.filter(layer => layer.id.startsWith('basemap-vector-') && layer.type === 'line').map(layer => layer.id);
      return map.areTilesLoaded() && map.queryRenderedFeatures({ layers }).length > 30;
    }, null, { timeout: 30000 });
    assert.equal(await page.locator('.map-view__error').count(), 0, `${name}: tiles and labels load without errors`);
    results.push({ name, searchMs: result.searchMs, suggestions: result.features.length });
    if (name === 'Paris') await page.screenshot({ path: output + '/paris.png' });
  }
  assert.deepEqual(external, [], 'Maps, fonts, symbols and search make no external requests');
  assert.deepEqual(errors, []);
  await writeFile(output + '/report.json', JSON.stringify({ results, external, errors }, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser.close(); }

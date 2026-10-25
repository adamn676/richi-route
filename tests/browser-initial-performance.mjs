import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
import routingSearch from '../src/config/routing-search.json' with { type: 'json' };

const { values } = parseArgs({ options: {
  baseline: { type: 'string', default: '0' },
  'baseline-origin': { type: 'string' },
  'optimized-origin': { type: 'string' },
  report: { type: 'string' },
} });
const baselineCoefficient = Number(values.baseline);
assert.ok(Number.isFinite(baselineCoefficient) && baselineCoefficient >= 0 && baselineCoefficient <= 1,
  'The baseline coefficient must be between 0 and 1');
const reportName = values.report ?? `browser-comparison-${baselineCoefficient}-to-${routingSearch.pass1coefficient}-${routingSearch.pass2coefficient}.json`;
assert.equal(reportName.includes('/'), false, 'Use a filename for the report');
for (const key of ['baseline-origin', 'optimized-origin']) {
  if (values[key]) assert.equal(new URL(values[key]).hostname, '127.0.0.1', 'Performance checks use local engines');
}
const graz = [15.393249918226957, 47.076550949654376];
const virgen = [12.456876612333161, 47.00334492589846];
const mistelbach = [16.5768, 48.5707];
const cases = [
  { name: 'Graz-Virgen', coords: [graz, virgen] },
  { name: 'Virgen-Mistelbach', coords: [virgen, mistelbach] },
  { name: 'Graz-Virgen-Mistelbach-Graz loop', coords: [graz, virgen, mistelbach, graz] },
];
const directory = new URL('../experiments/routing/.local/initial-route-speed/', import.meta.url);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true });
const report = {
  createdAt: new Date().toISOString(), browser: browser.version(), routingSearch,
  baselineSearch: { pass2coefficient: baselineCoefficient },
  baselineOrigin: values['baseline-origin'] ?? 'editor proxy',
  optimizedOrigin: values['optimized-origin'] ?? 'editor proxy',
  scope: 'Fresh routes in isolated desktop browser contexts on the running router. One warmup and three measured runs per variant and route, alternating order. Background map downloads excluded.',
  samples: [], summaries: [],
};

async function measure(item, variant, round) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    await context.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'street'));
    await context.route('**/tiles/**', route => route.fulfill({ status: 200,
      contentType: 'application/vnd.mapbox-vector-tile', body: Buffer.alloc(0) }));
    let requests = 0;
    await context.route('**/routing/brouter?**', async route => {
      const url = new URL(route.request().url());
      for (const [name, value] of Object.entries(routingSearch)) {
        assert.equal(url.searchParams.get(`profile:${name}`), String(value), 'The editor sends the configured search setting');
        if (variant === 'baseline') {
          url.searchParams.delete(`profile:${name}`);
          if (name === 'pass2coefficient' && baselineCoefficient !== 0) {
            url.searchParams.set(`profile:${name}`, String(baselineCoefficient));
          }
        }
      }
      requests++;
      const origin = variant === 'baseline' ? values['baseline-origin'] : values['optimized-origin'];
      if (origin) {
        // Fetch through Playwright so cross-origin test engines need no browser CORS changes.
        const target = new URL('/brouter', origin);
        target.search = url.search;
        const response = await route.fetch({ url: target.href, timeout: 75_000 });
        return route.fulfill({ response });
      }
      return route.continue({ url: url.href });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:5173/');
    await page.waitForFunction(() => document.querySelector('.route-layer')?.__vueParentComponent.props.map.isStyleLoaded());
    await page.evaluate(coords => {
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
      const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
      map.fitBounds([[Math.min(...coords.map(c => c[0])), Math.min(...coords.map(c => c[1]))],
        [Math.max(...coords.map(c => c[0])), Math.max(...coords.map(c => c[1]))]], { duration: 0, padding: 60 });
      const timing = window.initialRouteTiming = { start: performance.now(), calculatedMs: null, visibleMs: null, partialFrames: 0, error: null };
      function frame() {
        const pending = store.pendingLegCount || store.pendingSnapCount;
        const rendered = map.getLayer('segments-routed') ? map.queryRenderedFeatures({ layers: ['segments-routed'] }).length : 0;
        if (pending && rendered) timing.partialFrames++;
        if (!pending && Object.keys(store.legs).length === coords.length - 1) {
          if (store.hasAirLines) timing.error = store.errorMessage ?? 'Incomplete route';
          else {
            timing.calculatedMs ??= performance.now() - timing.start;
            if (rendered && map.isSourceLoaded('segments-source')) timing.visibleMs = performance.now() - timing.start;
          }
        }
        if (timing.visibleMs === null && !timing.error) requestAnimationFrame(frame);
      }
      store.resetRoute(coords);
      requestAnimationFrame(frame);
    }, item.coords);
    await page.waitForFunction(() => window.initialRouteTiming.visibleMs !== null || window.initialRouteTiming.error, null, { timeout: 160000 });
    const result = await page.evaluate(async () => {
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
      const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
      const legs = Object.values(store.legs);
      const data = await map.getSource('segments-source').getData();
      const completeDrawing = legs.every(leg => {
        const segments = data.features.filter(feature => feature.properties.legId === leg.id);
        const coords = segments.flatMap((feature, index) => index ? feature.geometry.coordinates.slice(1) : feature.geometry.coordinates);
        return JSON.stringify(coords) === JSON.stringify(leg.coordinates);
      });
      return { ...window.initialRouteTiming, completeDrawing, distanceKm: store.distanceMeters / 1000,
        vertices: legs.reduce((sum, leg) => sum + leg.coordinates.length, 0),
        geometry: legs.map(({ coordinates, elevations, surfaces, distanceMeters, ascentMeters }) =>
          ({ coordinates, elevations, surfaces, distanceMeters, ascentMeters })) };
    });
    assert.equal(result.error, null);
    assert.equal(result.completeDrawing, true, 'Every route coordinate reaches the map source');
    assert.equal(result.partialFrames, 0, 'The initial line appears after the full calculation');
    assert.equal(requests, item.coords.length * 2 - 1, 'Every route is freshly requested');
    await page.waitForFunction(() => ['saved', 'error'].includes(document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').draftStatus));
    assert.equal(await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').draftStatus), 'saved');
    assert.deepEqual(errors, []);
    result.geometrySha256 = createHash('sha256').update(JSON.stringify(result.geometry)).digest('hex');
    delete result.geometry;
    delete result.start;
    return { route: item.name, variant, round, warmup: round === 0, requests, ...result };
  } finally { await context.close(); }
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  for (const item of cases) {
    let expectedHash;
    for (let round = 0; round <= 3; round++) {
      for (const variant of round % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized']) {
        const result = await measure(item, variant, round);
        expectedHash ??= result.geometrySha256;
        assert.equal(result.geometrySha256, expectedHash, 'Search tuning preserves geometry, elevation and surfaces');
        report.samples.push(result);
        await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2));
        console.log(`${item.name}: ${variant}, ${round === 0 ? 'warmup' : `run ${round}`}, ${Math.round(result.visibleMs)} ms`);
      }
    }
    const samples = report.samples.filter(sample => sample.route === item.name && !sample.warmup);
    const baseline = samples.filter(sample => sample.variant === 'baseline').map(sample => sample.visibleMs);
    const optimized = samples.filter(sample => sample.variant === 'optimized').map(sample => sample.visibleMs);
    report.summaries.push({ route: item.name, distanceKm: samples[0].distanceKm, vertices: samples[0].vertices,
      baselineMedianMs: median(baseline), optimizedMedianMs: median(optimized),
      improvementPercent: 100 * (1 - median(optimized) / median(baseline)),
      baselineRangeMs: [Math.min(...baseline), Math.max(...baseline)], optimizedRangeMs: [Math.min(...optimized), Math.max(...optimized)] });
    await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report.summaries, null, 2));
} finally { await browser.close(); }

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const output = '.cache/map-performance';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu'] });
const results = [];
const candidates = [
  { name: 'baseline', workers: 1, options: {} },
  { name: 'two-workers', workers: 2, options: {} },
  { name: 'four-workers', workers: 4, options: {} },
  { name: 'split-tiles', workers: 2, options: { zoomLevelsToOverscale: 3 } },
];
try {
  for (const candidate of candidates.filter(item => !process.env.MAP_BENCH_CASE || item.name === process.env.MAP_BENCH_CASE)) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'street'));
    await page.route('**/src/config/map-worker.ts*', async route => {
      const response = await route.fetch();
      const original = await response.text();
      assert.ok(original.includes('setWorkerUrl(workerUrl)'));
      const body = original.replace('import { setWorkerUrl', 'import { setWorkerCount, setWorkerUrl')
        .replace('setWorkerUrl(workerUrl);', `setWorkerUrl(workerUrl); setWorkerCount(${candidate.workers});`);
      await route.fulfill({ response, body });
    });
    await page.route('**/src/composables/useEditorMap.ts*', async route => {
      const response = await route.fetch();
      const original = await response.text();
      assert.ok(original.includes('new Map({'));
      await route.fulfill({ response, body: original.replace('new Map({', `new Map({ ...${JSON.stringify(candidate.options)},`) });
    });
    await page.goto(origin);
    await page.waitForFunction(() => {
      const map = document.querySelector('.route-layer')?.__vueParentComponent.props.map;
      return map?.getSource('basemap-vector-europe') && map.areTilesLoaded();
    });
    const hardware = await page.evaluate(() => {
      const gl = document.querySelector('.maplibregl-canvas').getContext('webgl2');
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    for (const [place, center, zoom] of [
      ['Graz', [15.4395, 47.0707], 16], ['Graz', [15.4395, 47.0707], 20],
      ['Virgen', [12.458, 47.001], 16], ['Virgen', [12.458, 47.001], 20],
      ['Vienna', [16.3738, 48.2082], 16], ['Vienna', [16.3738, 48.2082], 20],
      ['Paris', [2.3488, 48.8534], 16], ['Paris', [2.3488, 48.8534], 20],
    ]) {
      const measurement = await page.evaluate(async ({ center, zoom }) => {
        const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
        const idle = action => new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Map did not settle')), 30000);
          map.once('idle', () => { clearTimeout(timeout); resolve(); });
          action();
        });
        const longTasks = [];
        const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)));
        observer.observe({ type: 'longtask' });
        const started = performance.now();
        await idle(() => map.jumpTo({ center, zoom }));
        const loadMs = Math.round(performance.now() - started);
        const frames = [];
        let running = true, previous;
        const frame = now => {
          if (previous) frames.push(now - previous);
          previous = now;
          if (running) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        const panStarted = performance.now();
        await idle(() => map.panBy([500, 150], { duration: 800, essential: true }));
        running = false;
        observer.disconnect();
        frames.sort((a, b) => a - b);
        const resources = performance.getEntriesByType('resource').filter(entry => entry.startTime >= started && entry.name.includes('/maps/'));
        return { loadMs, panMs: Math.round(performance.now() - panStarted),
          frameP95Ms: Math.round(frames[Math.floor(frames.length * .95)]),
          longTasks: longTasks.length, longestTaskMs: Math.round(Math.max(0, ...longTasks)),
          resourceCount: resources.length, resourceMs: Math.round(Math.max(0, ...resources.map(entry => entry.duration))),
          features: map.queryRenderedFeatures().length };
      }, { center, zoom });
      const result = { candidate: candidate.name, place, zoom, ...measurement };
      results.push(result);
      console.log(result);
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/${candidate.name}.png` });
    await writeFile(`${output}/${candidate.name}.json`, JSON.stringify({ candidate, hardware, results: results.filter(item => item.candidate === candidate.name) }, null, 2));
    await page.close();
  }
} finally { await browser.close(); }

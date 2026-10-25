import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
import { chooseBasemap } from './browser-ui.mjs';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const output = '.cache/map-rendering';
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu'],
  ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }) });
const page = await browser.newPage({ viewport: { width: 1200, height: 850 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'street'));
  await page.goto(origin);
  await page.waitForFunction(() => {
    const map = document.querySelector('.gpx-reference-layer')?.__vueParentComponent.props.map;
    return map?.getSource('basemap-vector-europe') && map.areTilesLoaded();
  }, {}, { timeout: 90000 });
  const hardware = await page.evaluate(() => {
    const gl = document.querySelector('.maplibregl-canvas').getContext('webgl2');
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      cores: navigator.hardwareConcurrency, pixelRatio: devicePixelRatio };
  });
  const results = [];
  for (const mode of ['street', 'aerial']) {
    await chooseBasemap(page, mode);
    for (const zoom of [12, 16, 18]) {
      const result = await page.evaluate(async ({ mode, zoom }) => {
        const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
        const idle = action => new Promise((resolve, reject) => {
          const done = () => { clearTimeout(timeout); resolve(); };
          const timeout = setTimeout(() => { map.off('idle', done); reject(new Error('Map did not settle.')); }, 90000);
          map.once('idle', done); action();
        });
        const start = performance.now();
        await idle(() => map.jumpTo({ center: [15.438, 47.071], zoom }));
        const loadMs = Math.round(performance.now() - start);
        const frames = [];
        let previous = performance.now(), running = true;
        const frame = now => {
          frames.push(now - previous); previous = now;
          if (running) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        await idle(() => map.easeTo({ center: [15.441, 47.071], duration: 1500, essential: true }));
        running = false;
        frames.sort((a, b) => a - b);
        return { mode, zoom, loadMs, frames: frames.length,
          frameMedianMs: Math.round(frames[Math.floor(frames.length * .5)]),
          frameP95Ms: Math.round(frames[Math.floor(frames.length * .95)]) };
      }, { mode, zoom });
      assert.ok(result.frames > 0 && Number.isFinite(result.frameP95Ms));
      results.push(result); console.log(result);
    }
  }
  assert.deepEqual(errors, []);
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/report.json`, JSON.stringify({ hardware, results, errors }, null, 2));
  console.log(hardware);
} finally { await browser.close(); }

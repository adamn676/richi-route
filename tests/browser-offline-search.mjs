// The address search built for browsers (search/wasm) on a phone: in Chromium with a phone's screen and its CPU slowed
// four times, it loads an index (SEARCH_INDEX, a region such as Styria) and answers the fixed search cases, once on the
// page and once in a worker, as the planner would run it. Reports load time, memory and time per search.
//   SEARCH_INDEX=styria.search node tests/browser-offline-search.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const indexFile = process.env.SEARCH_INDEX;
assert.ok(indexFile, 'Set SEARCH_INDEX to an index file.');
const output = '.cache/offline-search';
await mkdir(output, { recursive: true });
const cases = JSON.parse(await readFile(new URL('./search-cases.json', import.meta.url), 'utf8'));
const [lon, lat] = cases.focus;
const requests = [
  ...cases.forward.map(c => `/api/?${new URLSearchParams({ q: c.query, lang: 'de', limit: '20', bbox: '5,45,20,50', lat, lon, location_bias_scale: '0.5' })}`),
  ...cases.reverse.map(c => `/reverse?${new URLSearchParams({ lat: c.point[1], lon: c.point[0], lang: 'de', limit: '1', radius: '0.3' })}`),
];
const search = stripTypeScriptTypes(await readFile(new URL('../src/services/offline-search.ts', import.meta.url), 'utf8'));
const run = `import { startOfflineSearch } from './offline-search.js';
export async function measure(requests) {
  const started = performance.now();
  const [module, index] = await Promise.all(['/search.wasm', '/index.search'].map(url => fetch(url).then(r => r.arrayBuffer())));
  const fetched = performance.now();
  const search = await startOfflineSearch(module, new Uint8Array(index));
  const loaded = performance.now();
  const times = requests.map(request => { const t = performance.now(); search.ask(request); return performance.now() - t; });
  return { fetchMs: fetched - started, loadMs: loaded - fetched, memoryMb: search.memory() / 1e6, times };
}`;
const files = {
  '/offline-search.js': ['text/javascript', search],
  '/measure.js': ['text/javascript', run],
  '/worker.js': ['text/javascript', `import { measure } from './measure.js'; onmessage = async ({ data }) => postMessage(await measure(data));`],
  '/search.wasm': ['application/wasm', await readFile(new URL('../search/wasm/target/wasm32-unknown-unknown/release/richi_search_wasm.wasm', import.meta.url))],
  '/index.search': ['application/octet-stream', await readFile(indexFile)],
  '/': ['text/html', '<!doctype html><title>Offline search</title>'],
};
const server = createServer((request, response) => {
  const [type, body] = files[request.url] ?? [];
  if (!type) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': type }).end(body);
}).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(origin);
  const summary = ({ fetchMs, loadMs, memoryMb, times }) => {
    const sorted = [...times].sort((a, b) => a - b);
    const at = share => Math.round(sorted[Math.floor(share * (sorted.length - 1))] * 10) / 10;
    return { fetchMs: Math.round(fetchMs), loadMs: Math.round(loadMs), memoryMb: Math.round(memoryMb), medianMs: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
  };
  const onPage = summary(await page.evaluate(async requests => (await import('/measure.js')).measure(requests), requests));
  const inWorker = summary(await page.evaluate(requests => new Promise((resolve, reject) => {
    const worker = new Worker('/worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => resolve(data); worker.onerror = reject;
    worker.postMessage(requests);
  }), requests));
  const report = { index: indexFile, requests: requests.length, cpuSlowdown: 4, onPage, inWorker };
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  assert.ok(inWorker.p95Ms < 100, 'Searches stay within 100 ms on a slow phone');
} finally {
  await browser.close();
  server.close();
}

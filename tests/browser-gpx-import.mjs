import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const output = '.cache/gpx-import';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: process.env.PLAYWRIGHT_HEADED !== '1' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const errors = [];
let routingRequests = 0;
await context.addInitScript(origin => {
  if (location.origin === origin) localStorage.setItem('richiroute.review-basemap', 'local');
}, origin);
await context.route('**/tiles/**', route => route.fulfill({ status: 200, contentType: 'application/vnd.mapbox-vector-tile', body: Buffer.alloc(0) }));
await context.route('**/routing/**', route => { routingRequests++; return route.abort(); });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const gpx = (body, namespace = 'http://www.topografix.com/GPX/1/1', version = '1.1') => `<gpx version="${version}" xmlns="${namespace}">${body}</gpx>`;
const point = (lon, lat, ele = '') => `<trkpt lon="${lon}" lat="${lat}">${ele === '' ? '' : `<ele>${ele}</ele>`}</trkpt>`;
const upload = async (name, contents) => {
  await page.getByLabel('GPX-Datei auswählen', { exact: true }).setInputFiles({ name, mimeType: 'application/gpx+xml', buffer: Buffer.from(contents) });
  await page.waitForFunction(() => !document.querySelector('.gpx')?.textContent.includes('GPX wird eingelesen'));
};
const state = () => page.evaluate(() => {
  const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
  return JSON.stringify({ points: store.points, legs: store.legs, undo: store.undoStack });
});
try {
  await page.goto(origin);
  await page.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();

  // A GPX import must not alter an existing editable route or trigger routing.
  await page.evaluate(async () => {
    const { routingPolicyVersion } = await import('/src/config/routing-policy.ts');
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    const points = [
      { id: 'stop-a', type: 'stop', kind: 'start', coord: [15.4, 47.1], address: null, userInput: 'Existing start', isGeocoding: false },
      { id: 'stop-b', type: 'stop', kind: 'end', coord: [15.5, 47.2], address: null, userInput: 'Existing end', isGeocoding: false },
    ];
    store.restoreDraft({ version: 1, points, legs: { 'stop-a:stop-b': {
      id: 'stop-a:stop-b', fromId: 'stop-a', toId: 'stop-b', fromCoord: points[0].coord, toCoord: points[1].coord,
      coordinates: points.map(p => p.coord), elevations: [300, 400], distanceMeters: 15000, ascentMeters: 100,
      status: 'routed', surfaces: [], routingPolicy: routingPolicyVersion,
    } } });
  });
  const original = await state();
  const length = 50000;
  const coords = Array.from({ length }, (_, i) => [15.4 + i / 500000, 47.1 + Math.sin(i / 1000) / 100]);
  const longXml = gpx('<metadata><name>Große GPX-Runde</name></metadata><trk><name>Original</name><trkseg>' +
    coords.map(([lon, lat], i) => point(lon, lat, 300 + i % 50)).join('') +
    `</trkseg><trkseg>${point(16, 48, 600)}${point(16.01, 48.01)}</trkseg></trk>` +
    `<trk><name>Einzelpunkt</name><trkseg>${point(16.1, 48.1, 700)}</trkseg></trk>`);
  const started = performance.now();
  await upload('long.gpx', longXml);
  await page.getByRole('heading', { name: 'Große GPX-Runde', exact: true }).waitFor();
  await page.waitForFunction(async () => {
    const map = document.querySelector('.gpx-reference-layer')?.__vueParentComponent.props.map;
    return map?.getSource('gpx-reference') && (await map.getSource('gpx-reference').getData()).features.length === 3;
  });
  const rendered = await page.evaluate(async () => {
    const layer = document.querySelector('.gpx-reference-layer').__vueParentComponent;
    const track = layer.props.track;
    const geojson = await layer.props.map.getSource('gpx-reference').getData();
    return { coords: geojson.features[0].geometry.coordinates, count: track.pointCount,
      elevationCount: track.elevationCount, ascent: track.ascentMeters,
      lastType: geojson.features[2].geometry.type, elevations: track.segments[0].elevations,
      pathLength: track.profile.path.length, boundsVisible: track.bounds.every(coord => layer.props.map.getBounds().contains(coord)) };
  });
  assert.deepEqual(rendered.coords, coords);
  assert.deepEqual(rendered.elevations, coords.map((_, i) => 300 + i % 50));
  assert.equal(rendered.count, length + 3);
  assert.equal(rendered.elevationCount, length + 2);
  assert.equal(rendered.ascent, null);
  assert.equal(rendered.lastType, 'Point');
  assert.equal(rendered.boundsVisible, true);
  assert.ok(rendered.pathLength < 25000);
  assert.equal(await state(), original);
  assert.equal(routingRequests, 0);
  const importMs = Math.round(performance.now() - started);

  await page.getByLabel('Track einblenden', { exact: true }).uncheck();
  assert.equal(await page.evaluate(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getLayoutProperty('gpx-reference-line', 'visibility')), 'none');
  await page.getByRole('button', { name: 'Track zeigen', exact: true }).click();
  assert.equal(await page.getByLabel('Track einblenden', { exact: true }).isChecked(), true);
  await page.getByRole('combobox', { name: 'Kartenansicht', exact: true }).selectOption('aerial');
  await page.getByRole('combobox', { name: 'Kartenansicht', exact: true }).selectOption('local');
  assert.equal(await page.evaluate(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getLayoutProperty('gpx-reference-line', 'visibility')), 'visible');
  await upload('invalid.gpx', gpx(`<trk><trkseg>${point(181, 47)}</trkseg></trk>`));
  await page.locator('.gpx__error').waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Große GPX-Runde', exact: true }).count(), 1, 'Failed imports retain the previous reference');
  assert.equal(await state(), original);

  const limits = await page.evaluate(async () => {
    const { useGpxReferenceStore } = await import('/src/stores/gpx-reference.store.ts');
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    const store = useGpxReferenceStore(pinia);
    const old = store.track;
    await store.importFile(new File([new Uint8Array(32 * 1024 * 1024 + 1)], 'oversized.gpx'));
    const fileLimit = store.error.includes('32 MB') && store.track === old;
    const many = new File([`<gpx version="1.1"><trk><trkseg>${'<trkpt lon="15" lat="47"/>'.repeat(250001)}</trkseg></trk></gpx>`], 'many.gpx');
    await store.importFile(many);
    const pointLimit = store.error.includes('250.000') && store.track === old;
    const file = new File(['<gpx version="1.1"><trk><trkseg><trkpt lon="0" lat="0"/></trkseg></trk></gpx>'], 'late.gpx');
    let release;
    file.arrayBuffer = () => new Promise(resolve => { release = resolve; });
    const pending = store.importFile(file);
    store.cancel();
    release(new TextEncoder().encode('<gpx version="1.1"><trk><trkseg><trkpt lon="0" lat="0"/></trkseg></trk></gpx>').buffer);
    await pending;
    const cancelled = store.track === old && !store.loading;
    const NativeWorker = Worker;
    let stopped = 0, started;
    const created = new Promise(resolve => { started = resolve; });
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); started(); }
      terminate() { stopped++; super.terminate(); }
    };
    const parsing = store.importFile(many);
    await created;
    store.cancel();
    await parsing;
    window.Worker = NativeWorker;
    return { fileLimit, pointLimit, cancelled, workerStopped: stopped === 1 && store.track === old && !store.loading && !store.error };
  });
  assert.deepEqual(limits, { fileLimit: true, pointLimit: true, cancelled: true, workerStopped: true });

  await upload('long.gpx', longXml);
  await page.locator('.gpx').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: output + '/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Track zeigen', exact: true }).click();
  await page.locator('.gpx').evaluate(el => el.scrollIntoView({ block: 'start' }));
  for (const button of await page.locator('.gpx button:visible').all()) {
    const box = await button.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
  }
  await page.screenshot({ path: output + '/mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Track entfernen', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getSource('gpx-reference'));
  assert.equal(await state(), original);
  await upload('single.gpx', gpx(`<trk><trkseg>${point(15.4, 47.1, 0)}</trkseg></trk>`));
  await page.getByRole('heading', { name: 'single', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Track entfernen', exact: true }).count(), 0, 'Reference is session-only');
  assert.equal(routingRequests, 0);
  assert.deepEqual(errors, []);
  await writeFile(output + '/report.json', JSON.stringify({ points: length + 3, importAndReadbackMs: importMs, svgCharacters: rendered.pathLength,
    routingRequests, exactGeometryAndElevations: true, limits, passed: true }, null, 2) + '\n');
  console.log('GPX import: worker parsing, exact long-track geometry, segment gaps, partial elevation, controls, limits, cancellation, mobile and unchanged editor passed.');
} finally {
  await context.close();
  await browser.close();
}

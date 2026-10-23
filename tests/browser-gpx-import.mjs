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
  const parser = await page.evaluate(async () => {
    const { parseGpx } = await import('/src/domain/gpx-import.ts');
    const valid = '<trk><name>Test &amp; Runde</name><trkseg><trkpt lon="15" lat="47"><ele>100</ele></trkpt><trkpt lon="15.1" lat="47.1"/></trkseg><trkseg><trkpt lon="16" lat="48"><ele>500</ele></trkpt></trkseg></trk>';
    const wrap = (body, version = '1.1', ns = 'http://www.topografix.com/GPX/1/1') => `<gpx version="${version}" xmlns="${ns}">${body}</gpx>`;
    const standard = await parseGpx(wrap(valid), 'test.gpx');
    const old = await parseGpx(wrap('<name>Legacy</name>' + valid, '1.0', 'http://www.topografix.com/GPX/1/0'), 'old.gpx');
    const prefixed = await parseGpx('<g:gpx version="1.1" xmlns:g="http://www.topografix.com/GPX/1/1"><g:trk><g:trkseg><g:trkpt lon="0" lat="0"><g:ele>0</g:ele></g:trkpt></g:trkseg></g:trk></g:gpx>', 'prefix.gpx');
    const unnamespaced = await parseGpx(`<gpx version="1.1">${valid}</gpx>`, 'plain.gpx');
    const extensions = await parseGpx(wrap(valid + '<extensions xmlns:x="urn:test"><x:trk><x:trkseg><x:trkpt lon="200" lat="999"/></x:trkseg></x:trk></extensions>'), 'extensions.gpx');
    const invalid = [
      '<gpx>', '<html/>', wrap(''), wrap('<wpt lat="47" lon="15"/>'),
      wrap('<rte><rtept lat="47" lon="15"/></rte>'),
      wrap(valid, '2.0'), wrap(valid, '1.1', 'urn:not-gpx'),
      wrap(valid.replace('lon="15"', 'lon=""')), wrap(valid.replace('lat="47"', 'lat="91"')),
      wrap(valid.replace('lon="15"', 'lon="Infinity"')), wrap(valid.replace('lon="15"', 'lon="0x10"')),
      wrap(valid.replace('<ele>100</ele>', '<ele/>')), wrap(valid.replace('<ele>100</ele>', '<ele>NaN</ele>')),
      '<!DOCTYPE gpx [<!ENTITY x "hello">]>' + wrap(valid),
    ];
    const rejected = [];
    for (const xml of invalid) {
      try { await parseGpx(xml, 'invalid.gpx'); rejected.push(false); }
      catch { rejected.push(true); }
    }
    const controller = new AbortController(); controller.abort();
    let aborted = false;
    try { await parseGpx(wrap(valid), 'aborted.gpx', controller.signal); }
    catch (error) { aborted = error.name === 'AbortError'; }
    return { rejected, aborted, name: standard.name, count: standard.pointCount,
      segments: standard.segments.length, partial: standard.elevationCount,
      oldName: old.name, prefixCount: prefixed.pointCount, prefixElevation: prefixed.segments[0].elevations[0],
      plainCount: unnamespaced.pointCount, extensionsCount: extensions.pointCount };
  });
  assert.ok(parser.rejected.every(Boolean));
  assert.equal(parser.aborted, true);
  assert.equal(parser.name, 'Test & Runde');
  assert.equal(parser.count, 3);
  assert.equal(parser.segments, 2);
  assert.equal(parser.partial, 2);
  assert.equal(parser.oldName, 'Legacy');
  assert.equal(parser.prefixCount, 1);
  assert.equal(parser.prefixElevation, 0);
  assert.equal(parser.plainCount, 3);
  assert.equal(parser.extensionsCount, 3);

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
    const points = '<trkpt lon="15" lat="47"/>'.repeat(250001);
    await store.importFile(new File([`<gpx version="1.1"><trk><trkseg>${points}</trkseg></trk></gpx>`], 'many.gpx'));
    const pointLimit = store.error.includes('250.000') && store.track === old;
    const file = new File(['<gpx version="1.1"><trk><trkseg><trkpt lon="0" lat="0"/></trkseg></trk></gpx>'], 'late.gpx');
    let release;
    file.arrayBuffer = () => new Promise(resolve => { release = resolve; });
    const pending = store.importFile(file);
    store.cancel();
    release(new TextEncoder().encode('<gpx version="1.1"><trk><trkseg><trkpt lon="0" lat="0"/></trkseg></trk></gpx>').buffer);
    await pending;
    return { fileLimit, pointLimit, cancelled: store.track === old && !store.loading };
  });
  assert.deepEqual(limits, { fileLimit: true, pointLimit: true, cancelled: true });

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
    routingRequests, parserCases: parser.rejected.length, exactGeometryAndElevations: true, limits, passed: true }, null, 2) + '\n');
  console.log('GPX import: XML validation, versions/namespaces, exact long-track geometry, segment gaps, partial elevation, controls, limits, cancellation, mobile and unchanged editor passed.');
} finally {
  await context.close();
  await browser.close();
}

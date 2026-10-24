import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const output = '.cache/gpx-inspection';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: process.env.PLAYWRIGHT_HEADED !== '1' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, hasTouch: true });
const errors = [];
let routingRequests = 0;
await context.addInitScript(origin => {
  if (location.origin === origin) localStorage.setItem('richiroute.review-basemap', 'local');
}, origin);
await context.route('**/tiles/**', route => route.fulfill({ status: 200, contentType: 'application/vnd.mapbox-vector-tile', body: Buffer.alloc(0) }));
await context.route('**/routing/**', route => { routingRequests++; return route.abort(); });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const gpx = segments => '<gpx version="1.1"><trk><name>Track prüfen</name>' + segments.map(points => '<trkseg>' + points.map(([lon, lat, height]) =>
  `<trkpt lon="${lon}" lat="${lat}">${height === null ? '' : `<ele>${height}</ele>`}</trkpt>`).join('') + '</trkseg>').join('') + '</trk></gpx>';
const upload = async segments => {
  await page.getByRole('tab', { name: 'GPX', exact: true }).click();
  await page.getByLabel('GPX-Datei auswählen', { exact: true }).setInputFiles({ name: 'inspection.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx(segments)) });
  await page.waitForFunction(() => !document.querySelector('.gpx')?.textContent.includes('GPX wird eingelesen'));
  await page.waitForFunction(() => document.querySelector('.gpx-reference-layer')?.__vueParentComponent.props.map.getSource('gpx-reference'));
};
const data = id => page.evaluate(async id => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getSource(id).getData(), id);
const focus = () => page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('gpx-reference').focus);
const setPosition = value => page.evaluate(value => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('gpx-reference').focusAt(value), value);
const waitDot = async count => page.waitForFunction(async count => {
  const source = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getSource('gpx-reference-focus');
  return (await source.getData()).features.length === count;
}, count);
try {
  await page.goto(origin);
  await page.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();
  const points = Array.from({ length: 201 }, (_, i) => [15.40 + i / 10000, 47.10 + Math.sin(i / 30) / 1000, 300 + (i < 100 ? i : 200 - i)]);
  await upload([points]);
  await page.waitForFunction(() => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    return map.queryRenderedFeatures({ layers: ['gpx-reference-arrows'] }).length > 0;
  });
  const layers = await page.evaluate(() => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    map.on('error', event => { window.gpxMapErrors ??= []; window.gpxMapErrors.push(event.error.message); });
    return { upright: map.getLayoutProperty('gpx-reference-arrows', 'icon-keep-upright'),
      placement: map.getLayoutProperty('gpx-reference-arrows', 'symbol-placement'),
      icons: ['gpx-arrow', 'gpx-start', 'gpx-end', 'gpx-both'].every(id => map.hasImage(id)) };
  });
  assert.deepEqual(layers, { upright: false, placement: 'line', icons: true });
  assert.deepEqual((await data('gpx-reference-endpoints')).features.map(f => f.properties.icon), ['gpx-start', 'gpx-end']);
  const original = JSON.stringify(await data('gpx-reference'));
  for (const mode of ['elevation', 'gradient']) {
    await page.getByLabel('Trackfarbe', { exact: true }).selectOption(mode);
    await page.getByLabel('Legende der Trackfarben', { exact: true }).waitFor();
    await page.waitForFunction(async () => (await document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getSource('gpx-reference-colors').getData()).features.length > 1);
    const colored = await data('gpx-reference-colors');
    assert.ok(new Set(colored.features.map(f => f.properties.color)).size > 1);
    assert.equal(JSON.stringify(await data('gpx-reference')), original);
  }
  await page.evaluate(() => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    window.gpxSourceWrites = {};
    for (const id of ['gpx-reference', 'gpx-reference-colors', 'gpx-reference-endpoints', 'gpx-reference-focus']) {
      const source = map.getSource(id), setData = source.setData.bind(source);
      window.gpxSourceWrites[id] = 0;
      source.setData = (...args) => { window.gpxSourceWrites[id]++; return setData(...args); };
    }
  });
  const profile = page.getByRole('img', { name: 'Höhenprofil des importierten GPX-Tracks', exact: true });
  await profile.scrollIntoViewIfNeeded();
  const box = await profile.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await waitDot(1);
  const middle = await focus();
  const total = await page.evaluate(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.track.distanceMeters);
  assert.ok(Math.abs(middle.distance - total / 2) < 1);
  assert.deepEqual((await data('gpx-reference-focus')).features[0].geometry.coordinates, middle.coordinate);
  assert.match(await page.getByRole('slider', { name: 'Position im GPX-Track', exact: true }).getAttribute('aria-valuetext'), /km.*m Höhe.*% Steigung/);
  for (let i = 1; i < 20; i++) await page.mouse.move(box.x + box.width * i / 20, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.screenshot({ path: output + '/desktop.png', fullPage: true });
  const writes = await page.evaluate(() => window.gpxSourceWrites);
  assert.equal(writes['gpx-reference'], 0);
  assert.equal(writes['gpx-reference-colors'], 0);
  assert.equal(writes['gpx-reference-endpoints'], 0);
  assert.ok(writes['gpx-reference-focus'] >= 15);
  await page.mouse.move(1400, 10);
  await waitDot(0);
  const slider = page.getByRole('slider', { name: 'Position im GPX-Track', exact: true });
  assert.equal(await page.locator('.gpx input[type=range]').count(), 0, 'The chart has no separate slider');
  await slider.focus(); await slider.press('End');
  await waitDot(1);
  assert.ok(Math.abs((await focus()).distance - total) < .2);
  await slider.press('Home');
  await page.waitForFunction(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('gpx-reference').focus?.distance === 0);
  assert.deepEqual((await focus()).coordinate, points[0].slice(0, 2));
  await page.getByLabel('Track einblenden', { exact: true }).uncheck();
  await waitDot(0);
  assert.equal(await slider.getAttribute('aria-disabled'), 'true');
  await page.getByRole('button', { name: 'Track zeigen', exact: true }).click();
  await profile.scrollIntoViewIfNeeded();
  const mapBox = await profile.boundingBox();
  await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await waitDot(1);
  const basemaps = ['street', 'aerial', 'local'];
  for (const basemap of basemaps) {
    const selected = await focus();
    await page.getByRole('combobox', { name: 'Kartenansicht', exact: true }).selectOption(basemap);
    if (basemap === 'street') await page.waitForFunction(() => document.querySelector('.gpx-reference-layer')
      .__vueParentComponent.props.map.getStyle().layers.some(layer => layer.id.startsWith('basemap-vector-')));
    await waitDot(1);
    assert.deepEqual(await focus(), selected, `${basemap} preserves the inspected position`);
    await page.mouse.move(mapBox.x + mapBox.width * .4, mapBox.y + mapBox.height / 2);
    await page.waitForFunction(() => {
      const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
      return map.hasImage('gpx-arrow') && map.getLayoutProperty('gpx-reference-color-line', 'visibility') === 'visible'
        && map.queryRenderedFeatures({ layers: ['gpx-reference-dot'] }).length > 0
        && map.queryRenderedFeatures({ layers: ['gpx-reference-arrows'] }).length > 0;
    });
    assert.equal(JSON.stringify(await data('gpx-reference')), original);
  }

  // A westbound track must retain its coordinate order and reverse the arrows.
  await upload([[...points].reverse()]);
  assert.deepEqual((await data('gpx-reference')).features[0].geometry.coordinates[0], points.at(-1).slice(0, 2));
  await page.getByLabel('Trackfarbe', { exact: true }).selectOption('plain');
  await page.waitForFunction(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.areTilesLoaded());
  await page.screenshot({ path: output + '/westbound.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await profile.scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Track zeigen', exact: true }).click();
  await profile.scrollIntoViewIfNeeded();
  const touchBox = await profile.boundingBox();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchBox.x + touchBox.width * .25, y: touchBox.y + touchBox.height / 2 }] });
  await waitDot(1);
  const firstTouch = (await focus()).distance;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchBox.x + touchBox.width * .75, y: touchBox.y + touchBox.height / 2 }] });
  await page.waitForFunction(first => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('gpx-reference').focus?.distance > first, firstTouch);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.screenshot({ path: output + '/mobile.png', fullPage: true });
  await cdp.detach();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

  await upload([[[15.4, 47.1, 100], [15.41, 47.1, null]], [[15.42, 47.1, 300], [15.43, 47.1, 310]]]);
  assert.equal(await focus(), null);
  await page.getByLabel('Trackfarbe', { exact: true }).selectOption('elevation');
  await page.waitForFunction(async () => (await document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getSource('gpx-reference-colors').getData()).features.some(f => f.properties.color === '#87939a'));
  await setPosition((await page.evaluate(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.track.distanceMeters)) / 4);
  await waitDot(1);
  assert.equal((await focus()).elevation, null);
  assert.match(await page.getByRole('slider', { name: 'Position im GPX-Track', exact: true }).getAttribute('aria-valuetext'), /Höhe unbekannt/);

  await upload([[[15.4, 47.1, null], [15.41, 47.1, null]]]);
  assert.equal(await page.getByLabel('Trackfarbe', { exact: true }).inputValue(), 'plain');
  assert.equal(await page.locator('option[value=elevation]').evaluate(el => el.disabled), true, 'Elevation colouring is disabled when the track has no heights');
  await setPosition(100); await waitDot(1);
  assert.equal((await focus()).gradient, null);

  await page.setViewportSize({ width: 1440, height: 1100 });
  const longPoints = Array.from({ length: 50000 }, (_, i) => [15.4 + i / 500000, 47.1 + Math.sin(i / 1000) / 100, 300 + i % 50]);
  await upload([longPoints]);
  const started = performance.now();
  await page.getByLabel('Trackfarbe', { exact: true }).selectOption('gradient');
  await page.waitForFunction(async () => {
    const features = (await document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getSource('gpx-reference-colors').getData()).features;
    return features.length > 0 && features.reduce((n, f) => n + f.geometry.coordinates.length - 1, 1) === 50000;
  });
  const colorAndReadbackMs = Math.round(performance.now() - started);
  const colored = await data('gpx-reference-colors');
  assert.ok(colored.features.length <= 5001);
  await setPosition(100); await waitDot(1);
  await page.getByRole('button', { name: 'Track entfernen', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.getSource('gpx-reference-focus'));
  assert.equal(await focus(), null);
  assert.equal(routingRequests, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.gpxMapErrors ?? []), []);
  await writeFile(output + '/report.json', JSON.stringify({ passed: true, points: longPoints.length, colorAndReadbackMs,
    colorSections: colored.features.length, hoverSourceWrites: writes, basemaps, routingRequests }, null, 2) + '\n');
  console.log('GPX inspection: directions, endpoints, colours, profile hover, keyboard, touch, missing heights, style changes and 50,000-point track passed.');
} finally { await context.close(); await browser.close(); }

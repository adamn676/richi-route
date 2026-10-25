import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
import { chooseBasemap, closeMenus } from './browser-ui.mjs';
const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const output = '.cache/map-style';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true, args: ['--enable-gpu'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, hasTouch: true });
const externalRequests = [];
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) {
    externalRequests.push(url.href);
  }
  return route.continue();
});
const page = await context.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const terrainTiles = [];
page.on('response', response => {
  if (response.url().includes('/maps/terrain/') && response.status() === 200) terrainTiles.push(response.url());
});
const mapState = () => page.evaluate(() => {
  const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
  const layers = map.getStyle().layers.filter(l => l.id.startsWith('basemap-vector-'));
  const lineIds = layers.filter(l => l.type === 'line' && l['source-layer'] === 'roads').map(l => l.id);
  return { layers: layers.length, canvasWidth: map.getCanvas().width, cssWidth: map.getCanvas().clientWidth,
    roads: lineIds.length ? map.queryRenderedFeatures({ layers: lineIds }).length : 0,
    visible: layers.some(l => l.type === 'line' && l['source-layer'] === 'roads' && l.layout.visibility !== 'none') };
});
const waitMap = () => page.waitForFunction(() => {
  const map = document.querySelector('.gpx-reference-layer')?.__vueParentComponent.props.map;
  const ids = map?.getStyle().layers.filter(l => l.id.startsWith('basemap-vector-') && l.type === 'line').map(l => l.id);
  return ids?.length && map.areTilesLoaded() && map.queryRenderedFeatures({ layers: ids }).length > 30;
}, {}, { timeout: 60000 });
const waitAerial = target => target.waitForFunction(() => {
  const map = document.querySelector('.gpx-reference-layer')?.__vueParentComponent.props.map;
  const ids = map?.getStyle().layers.filter(layer => layer.id.startsWith('basemap-hybrid-') && layer.type === 'symbol').map(layer => layer.id);
  return ids?.length && map.areTilesLoaded()
    && map.queryRenderedFeatures({ layers: ids }).length > 0
    && map.queryRenderedFeatures({ layers: ['basemap-hybrid-road'] }).length > 0;
}, {}, { timeout: 60000 });
const waitStreetNames = target => target.waitForFunction(() => {
  const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
  const layers = map.getStyle().layers;
  const labels = layers.filter(layer => layer.id.includes('roads_labels_') && layer.layout.visibility !== 'none');
  const routeTop = Math.max(...layers.map((layer, index) => layer.id.startsWith('segments-') ? index : -1));
  return map.areTilesLoaded() && labels.length && labels.every(layer => layers.indexOf(layer) > routeTop)
    && map.queryRenderedFeatures({ layers: labels.map(layer => layer.id) }).some(feature => feature.properties.name || feature.properties['pgf:name']);
}, {}, { timeout: 30000 });
try {
  await page.goto(origin);
  await waitMap();
  await waitStreetNames(page);
  for (const zoom of [5, 8, 11, 14, 18, 13]) {
    await page.evaluate(zoom => new Promise(resolve => {
      const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
      map.once('idle', resolve); map.jumpTo({ zoom });
    }), zoom);
    assert.ok(await page.evaluate(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map
      .queryRenderedFeatures().some(feature => feature.layer['source-layer'] === 'roads')), `Roads remain visible at zoom ${zoom}`);
    await page.screenshot({ path: `${output}/street-zoom-${zoom}.png` });
  }
  const state = await mapState();
  assert.ok(state.layers > 50); assert.equal(state.canvasWidth, state.cssWidth * 2);
  await page.screenshot({ path: output + '/desktop.png' });
  await chooseBasemap(page, 'aerial');
  await waitAerial(page);
  await waitStreetNames(page);
  assert.equal((await mapState()).visible, false);
  assert.equal(await page.evaluate(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map
    .getLayoutProperty('aerial', 'visibility')), 'visible');
  await chooseBasemap(page, 'street');
  await waitStreetNames(page);
  assert.equal((await mapState()).visible, true);
  assert.deepEqual(await page.evaluate(() => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    return ['aerial', 'basemap-hybrid-road'].map(id => map.getLayoutProperty(id, 'visibility'));
  }), ['none', 'none']);
  // Karte uses the cycling road colours.
  assert.equal(await page.evaluate(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map
    .getPaintProperty('basemap-vector-roads_minor_casing', 'line-color')), '#738f81');
  await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route')
    .resetRoute([[15.438, 47.068], [15.444, 47.074]]));
  await page.waitForFunction(() => {
    const route = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    return !route.pendingSnapCount && !route.pendingLegCount && route.distanceMeters > 0 && !route.hasAirLines;
  }, {}, { timeout: 60000 });
  await page.evaluate(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map
    .jumpTo({ center: [15.4395, 47.0707], zoom: 16 }));
  for (const mode of ['street', 'aerial']) {
    await chooseBasemap(page, mode);
    await waitStreetNames(page);
    await page.waitForFunction(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map
      .queryRenderedFeatures({ layers: ['segments-routed'] }).length > 0);
    await page.screenshot({ path: `${output}/street-names-route-${mode}.png` });
  }
  await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').resetRoute());
  await waitStreetNames(page);
  // A pointer choice applies the map and closes the menu.
  const basemapMenu = page.getByRole('button', { name: 'Kartenansicht', exact: true });
  await basemapMenu.click();
  await page.getByText('Satellit', { exact: true }).click();
  assert.equal(await basemapMenu.getAttribute('aria-expanded'), 'false');
  await chooseBasemap(page, 'street');
  // Schummerung is a checkbox, so the menu stays open for further choices.
  await basemapMenu.click();
  await page.getByText('Schummerung', { exact: true }).click();
  assert.equal(await basemapMenu.getAttribute('aria-expanded'), 'true');
  await closeMenus(page);
  await page.waitForFunction(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map
    .getLayoutProperty('basemap-hillshade', 'visibility') === 'visible');
  await page.evaluate(() => new Promise(resolve => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    map.once('idle', resolve); map.jumpTo({ center: [12.458, 47.001], zoom: 11 });
  }));
  await page.screenshot({ path: output + '/terrain-virgen.png' });
  assert.match(await page.locator('.maplibregl-ctrl-attrib').textContent(), /Mapterhorn/);
  assert.ok(terrainTiles.length, 'Terrain uses locally served DEM tiles');
  await page.reload();
  await waitMap();
  // The menu builds its content when opened.
  await page.getByRole('button', { name: 'Kartenansicht', exact: true }).click();
  assert.equal(await page.locator('input[name=basemap]:checked').inputValue(), 'street');
  await closeMenus(page);
  assert.equal(await page.evaluate(() => localStorage.getItem('richiroute.hillshade')), '1');
  await page.evaluate(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.jumpTo({ center: [15.4395, 47.0707] }));
  await page.evaluate(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.jumpTo({ zoom: 13 }));
  await chooseBasemap(page, 'street');
  await waitMap();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.mouse.move(0, 0);
  await waitMap();
  await page.screenshot({ path: output + '/mobile.png' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.match(await page.locator('.maplibregl-ctrl-attrib').textContent(), /OpenStreetMap/);
  const aerial = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  aerial.on('pageerror', error => errors.push(error.message));
  let detailedImagery = 0, legacyLabels = 0;
  aerial.on('response', response => {
    if (response.status() === 200 && response.url().includes('/maps/imagery/20/')) detailedImagery++;
    if (response.url().includes('/bmapoverlay/')) legacyLabels++;
  });
  await aerial.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'aerial'));
  await aerial.goto(origin);
  await waitAerial(aerial);
  await aerial.evaluate(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.jumpTo({ center: [15.4395, 47.0707], zoom: 16 }));
  await waitAerial(aerial);
  await aerial.screenshot({ path: output + '/aerial-desktop.png' });
  const detailedResponse = aerial.waitForResponse(response => response.status() === 200
    && response.url().includes('/maps/imagery/20/'));
  await aerial.evaluate(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.jumpTo({ zoom: 20 }));
  await detailedResponse.catch(async error => {
    console.log('High-zoom map state', await aerial.evaluate(() => {
      const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
      return { zoom: map.getZoom(), center: map.getCenter(), loaded: map.areTilesLoaded(), error: document.querySelector('.map-view__error')?.textContent };
    }));
    throw error;
  });
  await aerial.waitForFunction(() => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    return map.areTilesLoaded() && map.isSourceLoaded('basemap-aerial');
  }, {}, { timeout: 60000 });
  assert.ok(detailedImagery > 0, 'The provider supplies actual level-20 imagery tiles');
  assert.equal(legacyLabels, 0, 'The aerial map uses crisp vector labels without the legacy raster overlay');
  await aerial.setViewportSize({ width: 390, height: 844 });
  await aerial.evaluate(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.jumpTo({ zoom: 16 }));
  await waitAerial(aerial);
  await aerial.screenshot({ path: output + '/aerial-mobile.png' });
  assert.ok(await aerial.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await aerial.close();
  const fallback = await browser.newPage();
  const fallbackRequests = [];
  let unavailable = true;
  await fallback.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) fallbackRequests.push(url.href);
    if (url.pathname === '/maps/style.json' && unavailable) return route.abort();
    return route.continue();
  });
  await fallback.goto(origin);
  await fallback.getByText('Lokale Straßenkarte nicht erreichbar.', { exact: false }).waitFor();
  assert.deepEqual(fallbackRequests, [], 'An unavailable local map never falls back to an external provider');
  unavailable = false;
  await fallback.getByRole('button', { name: 'Erneut laden', exact: true }).click();
  await fallback.waitForFunction(() => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    return map.getSource('basemap-vector-europe') && map.areTilesLoaded() && map.queryRenderedFeatures().length > 30;
  });
  assert.equal(await fallback.getByRole('alert').count(), 0);
  await fallback.close();
  const imageryFailure = await browser.newPage();
  let imageryUnavailable = true;
  await imageryFailure.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'aerial'));
  await imageryFailure.route('**/maps/imagery*.json', route => imageryUnavailable
    ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.continue());
  await imageryFailure.goto(origin);
  await imageryFailure.getByRole('alert').waitFor();
  imageryUnavailable = false;
  await imageryFailure.getByRole('button', { name: 'Erneut laden', exact: true }).click();
  await waitAerial(imageryFailure);
  assert.equal(await imageryFailure.getByRole('alert').count(), 0, 'Retry also recovers failed imagery metadata');
  await imageryFailure.close();
  const terrainFailure = await browser.newPage();
  let terrainUnavailable = true;
  await terrainFailure.addInitScript(() => localStorage.setItem('richiroute.hillshade', '1'));
  await terrainFailure.route('**/maps/terrain.json', route => terrainUnavailable
    ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.continue());
  await terrainFailure.goto(origin);
  await terrainFailure.getByRole('alert').waitFor();
  terrainUnavailable = false;
  await terrainFailure.getByRole('button', { name: 'Erneut laden', exact: true }).click();
  await terrainFailure.waitForFunction(() => {
    const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
    return map.isSourceLoaded('basemap-terrain') && map.areTilesLoaded();
  });
  assert.equal(await terrainFailure.getByRole('alert').count(), 0);
  await terrainFailure.close();
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  await writeFile(output + '/report.json', JSON.stringify({ passed: true, ...state, aerial: { detailedImagery, legacyLabels },
    streetNames: { withoutRoute: true, withRoute: true, afterClearing: true, aboveRoute: true }, localFailure: true, errors }, null, 2));
  console.log('Maps: streets, aerial overlay, street names with and without a route, level-20 imagery, pixel density, map switching, mobile and failure recovery passed.');
} finally { await browser.close(); }

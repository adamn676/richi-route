import assert from 'node:assert/strict';
import { chromium } from '../../../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const runId = '2026-10-20T16-56-41-400Z-2ac5138f';
const link = `http://127.0.0.1:5174/?case=07-south-quiet&variant=automatic&run=${runId}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  let routingRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/run')) routingRequests++; });
  await page.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'local'));
  await page.goto(link, { waitUntil: 'networkidle' });
  await page.locator('.inspection-chart').waitFor();
  const panel = await page.locator('.route-inspector').boundingBox();
  assert.ok(panel.y + panel.height <= 900, 'Map and profile fit together on desktop.');
  assert.equal(await page.locator('.route-choice[aria-pressed="true"]').count(), 1);
  assert.match(await page.locator('.route-choice[aria-pressed="true"]').innerText(), /BRouter/);
  assert.match(await page.locator('.inspector-heading').first().innerText(), /335 to 342 m.*6 m ascent/);
  assert.equal(await page.locator('.comparison-setup').getAttribute('open'), null);
  const mapState = () => page.locator('.map-canvas').evaluate(el => {
    const map = el.__vueParentComponent.setupState.map;
    return {
      routes: map.getSource('routes')._data.features,
      filter: map.getFilter('selected-route'),
      zoom: map.getZoom(),
    };
  });
  const originalRoutes = (await mapState()).routes;
  await page.getByRole('button', { name: /Next difference/ }).click();
  assert.match(await page.getByRole('button', { name: /Next difference/ }).innerText(), /1\/1/);
  assert.ok((await mapState()).zoom > 16, 'Difference navigation zooms into the Feldkirchen fork.');
  for (const [name, engine] of [['GraphHopper', 'graphhopper'], ['OpenRouteService', 'ors'], ['BRouter', 'brouter']]) {
    await page.locator('.route-choice').filter({ hasText: name }).click();
    await page.waitForFunction(id => {
      const map = document.querySelector('.map-canvas').__vueParentComponent.setupState.map;
      return map.getFilter('selected-route')[2] === id && map.loaded();
    }, originalRoutes.find(f => f.properties.engine === engine).properties.id);
    const state = await mapState();
    assert.equal(state.filter[2], originalRoutes.find(f => f.properties.engine === engine).properties.id);
    assert.ok(state.zoom > 16, 'Changing engines keeps the difference in view.');
    assert.deepEqual(state.routes.map(f => f.geometry), originalRoutes.map(f => f.geometry));
  }
  await page.screenshot({ path: 'experiments/routing/.local/comparison-difference.png', fullPage: true });
  await page.getByLabel('GraphHopper', { exact: true }).uncheck();
  assert.equal(await page.getByRole('button', { name: /Next difference/ }).isDisabled(), true);
  await page.locator('.route-choice').filter({ hasText: 'GraphHopper' }).click();
  assert.equal(await page.getByLabel('GraphHopper', { exact: true }).isChecked(), true);
  await page.getByRole('button', { name: 'Selected only', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.map-canvas').__vueParentComponent.setupState.map.getSource('routes')._data.features.length === 1);
  await page.getByRole('button', { name: 'All routes', exact: true }).click();
  await page.locator('.route-choice').filter({ hasText: 'BRouter' }).click();
  await page.locator('.inspection-chart').waitFor();
  await page.getByRole('button', { name: 'Fit routes', exact: true }).click();
  const range = page.getByLabel('Position along selected route');
  await range.focus();
  await range.press('End');
  await page.locator('.inspection-position').waitFor();
  assert.match(await page.locator('.position-readout').innerText(), /4.27 km/);
  const endPosition = await page.locator('.inspection-position').getAttribute('style');
  await range.press('Home');
  assert.match(await page.locator('.position-readout').innerText(), /0.00 km/);
  assert.notEqual(await page.locator('.inspection-position').getAttribute('style'), endPosition);
  await page.getByRole('button', { name: 'Find Stone setts sections' }).click();
  assert.match(await page.locator('.surface-map-label').innerText(), /BRouter/);
  assert.match(await page.locator('.position-readout').innerText(), /Stone setts/);
  await page.locator('.surface-sections summary').click();
  assert.equal(await page.locator('.surface-section-list button').count(), 18);
  assert.equal(await page.locator('.surface-section-list button[aria-pressed="true"]').count(), 1);
  await page.locator('.surface-section-list button').filter({ hasText: 'Unknown' }).last().click();
  assert.match(await page.locator('.position-readout').innerText(), /Unknown/);
  await page.waitForFunction(() => {
    const map = document.querySelector('.map-canvas').__vueParentComponent.setupState.map;
    return map.getZoom() > 17 && map.loaded() && map.queryRenderedFeatures({ layers: ['surface-lines'] }).length > 0;
  });
  assert.equal(await page.locator('.map-canvas').evaluate(el => el.__vueParentComponent.setupState.map.getSource('selected-section')._data.features.length), 1);
  await page.screenshot({ path: 'experiments/routing/.local/inspection-section.png', fullPage: true });
  await page.getByRole('button', { name: 'Show engine colours' }).click();
  await page.locator('.route-choice').filter({ hasText: 'GraphHopper' }).click();
  await page.getByText('This saved GraphHopper route has no elevation data.', { exact: false }).waitFor();
  assert.equal(await page.locator('.inspection-chart').count(), 0);
  await page.locator('.route-choice').filter({ hasText: 'OpenRouteService' }).click();
  await page.getByText('This saved OpenRouteService route has no elevation data.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Find Paving stones sections' }).waitFor();
  await page.locator('.route-choice').filter({ hasText: 'BRouter' }).click();
  await page.locator('.inspection-chart').waitFor();
  await page.getByRole('button', { name: 'Fit routes' }).click();
  await page.screenshot({ path: 'experiments/routing/.local/inspection-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /Next difference/ }).click();
  const mobileZoom = (await mapState()).zoom;
  assert.ok(mobileZoom > 15.5, `Mobile difference view zooms into the fork: ${mobileZoom}`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'experiments/routing/.local/comparison-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Show surface colours' }).click();
  await page.waitForFunction(() => document.querySelector('.map-canvas').__vueParentComponent.setupState.map.queryRenderedFeatures({ layers: ['surface-lines'] }).length > 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const map = await page.locator('.map-shell').boundingBox();
  const setup = await page.locator('.sidebar-secondary').boundingBox();
  assert.ok(map.y < setup.y, 'Secondary settings follow the map on mobile.');
  await page.screenshot({ path: 'experiments/routing/.local/inspection-mobile.png', fullPage: true });
  // An unavailable raw response must not leave the previous engine's details visible.
  await page.route('**/api/route-inspection?**', route => route.fulfill({ status: 400, json: { error: 'Saved route details unavailable.' } }));
  await page.locator('.route-choice').filter({ hasText: 'GraphHopper' }).click();
  await page.getByRole('alert').filter({ hasText: 'Saved route details unavailable.' }).waitFor();
  assert.equal(await page.locator('.route-inspector').count(), 0);
  await page.unroute('**/api/route-inspection?**');
  await page.getByRole('button', { name: 'Retry details' }).click();
  await page.getByText('This saved GraphHopper route has no elevation data.', { exact: false }).waitFor();
  assert.equal(routingRequests, 0, 'Inspection never recalculates the saved route.');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ desktop: 'passed', mobile: 'passed', sections: 18, routingRequests, errors }));
} finally {
  await browser.close();
}

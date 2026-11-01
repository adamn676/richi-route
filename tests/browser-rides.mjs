import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
import { lineTile } from '../scripts/offline/tiles.mjs';

// Richi Fahrten with made-up tiles: offered only where the map service has the rider's roads, drawn when switched on,
// remembered across a reload.
const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));

// Every tile holds a road ridden five times, across the tile through its middle.
const tile = lineTile('rides', 'rides', new Map([[5, [[[0, 2048], [4096, 2048]]]]]));
let available = false;
await context.route(`${origin}/maps/rides**`, route => {
  const url = route.request().url();
  if (!available) return route.fulfill({ status: 404 });
  if (url.endsWith('/rides.json')) {
    return route.fulfill({ json: { tilejson: '3.0.0', tiles: ['/maps/rides/{z}/{x}/{y}.mvt'], minzoom: 6, maxzoom: 14, bounds: [5, 45, 20, 50] } });
  }
  // Only real tile addresses, as the map service answers.
  if (!/\/maps\/rides\/\d+\/\d+\/\d+\.mvt$/.test(url)) return route.fulfill({ status: 404 });
  return route.fulfill({ body: tile, contentType: 'application/vnd.mapbox-vector-tile' });
});

const page = await context.newPage();
const open = async () => {
  await page.goto(origin);
  await page.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Kartenansicht', exact: true }).click();
  await page.getByLabel('Geländerelief').waitFor();
};
const drawn = () => page.evaluate(() => new Promise(resolve => {
  const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
  const check = () => resolve(map.getLayer('rides') && map.getLayoutProperty('rides', 'visibility') !== 'none'
    ? map.queryRenderedFeatures({ layers: ['rides'] }).length : 0);
  if (map.loaded()) check(); else map.once('idle', check);
}));

// Without the rider's roads, nothing to offer.
await open();
assert.equal(await page.getByLabel('Richi Fahrten').count(), 0);

// With them: switched on, the roads are drawn.
available = true;
await open();
await page.getByLabel('Richi Fahrten').check();
await page.waitForFunction(() => document.querySelector('.route-layer').__vueParentComponent.props.map.getLayer('rides'));
await page.keyboard.press('Escape');
assert.ok(await drawn() > 0, 'Rides drawn');

// Remembered after a reload; switched off, gone.
await open();
assert.ok(await page.getByLabel('Richi Fahrten').isChecked());
await page.getByLabel('Richi Fahrten').uncheck();
await page.keyboard.press('Escape');
assert.equal(await drawn(), 0);
assert.deepEqual(errors, []);
await browser.close();
console.log('Richi Fahrten: offered with the rider\'s roads, drawn, remembered and switched off passed.');

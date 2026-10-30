import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
import { chooseBasemap } from './browser-ui.mjs';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const output = '.cache/cycling';
await mkdir(output, { recursive: true });
const response = await fetch(`${origin}/maps/cycling.json?bbox=15.39,47.055,15.46,47.09`);
assert.equal(response.status, 200);
const data = await response.json();
assert.ok(data.features.filter(f => f.properties.kind === 'water').length > 5, 'Real drinking-water coverage in Graz');
assert.ok(data.features.some(f => f.properties.kind === 'station'), 'Real railway stations in Graz');
assert.equal((await fetch(`${origin}/maps/cycling.json?bbox=-180,-90,180,90`)).status, 400);
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu'],
  ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, hasTouch: true });
  const errors = [], external = [];
  let pointRequests = 0;
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().includes('/cycling.json')) pointRequests++; });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) { external.push(url.href); return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem('richiroute.review-basemap', 'street');
    if (!localStorage.getItem('richiroute.cycling-overlays')) localStorage.setItem('richiroute.cycling-overlays', '[]');
  });
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('.route-layer')?.__vueParentComponent.props.map.getLayer('cycling-water'));
  assert.equal(pointRequests, 0, 'Disabled overlays do not fetch POIs');
  const jump = (center, zoom) => page.evaluate(({center,zoom}) => new Promise(resolve => {
    const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
    map.once('idle', resolve); map.jumpTo({center,zoom});
  }), {center,zoom});
  await jump([15.4395,47.0707], 15);
  await page.locator('.cycling-controls .map-menu__trigger').click();
  for (const label of ['Trinkwasser', 'Radwege', 'Reparatur & Radläden', 'Verpflegung', 'Bahnhöfe']) {
    await page.getByRole('checkbox', { name: label, exact: false }).check();
  }
  const waitWater = () => page.waitForFunction(() => {
    const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
    return map.queryRenderedFeatures({ layers: ['cycling-water'] }).length > 0;
  });
  await waitWater();
  const before = await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').points.length);
  await page.screenshot({path:`${output}/desktop.png`});
  await page.locator('.cycling-controls .map-menu__trigger').click();
  const target = await page.evaluate(() => {
    const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
    const bounds = map.getCanvas().getBoundingClientRect();
    for (const feature of map.queryRenderedFeatures({layers:['cycling-water']})) {
      const point = map.project(feature.geometry.coordinates);
      if(point.x > 100 && point.x < bounds.width-100 && point.y > 110 && point.y < bounds.height-150)
        return {x:bounds.x+point.x,y:bounds.y+point.y};
    }
  });
  assert.ok(target);
  await page.mouse.click(target.x,target.y);
  await page.locator('.cycling-popup').waitFor();
  assert.match(await page.locator('.cycling-popup').textContent(), /Trinkwasser/);
  assert.equal(await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').points.length), before,
    'Inspecting a drinking-water point does not add a waypoint');
  await page.screenshot({path:`${output}/water-details.png`});
  await page.getByRole('button',{name:'Close popup'}).click();
  for (const mode of ['aerial','street']) {
    await chooseBasemap(page, mode);
    await waitWater();
    assert.equal(await page.evaluate(() => document.querySelector('.route-layer').__vueParentComponent.props.map.getLayoutProperty('cycling-cycleways','visibility')), 'visible');
  }
  assert.deepEqual(JSON.parse(await page.evaluate(()=>localStorage.getItem('richiroute.cycling-overlays'))).sort(), ['cycleways','food','repair','stations','water']);
  await page.reload();
  await waitWater();
  await page.evaluate(() => {
    const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
    window.cyclingMapErrors = [];
    map.on('error', event => window.cyclingMapErrors.push(event.error?.message));
  });
  await page.locator('.cycling-controls .map-menu__trigger').click();
  await page.locator('.cycling-controls .map-menu__panel').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 5, 'Selections survive a reload');
  await page.getByRole('checkbox', { name: 'Trinkwasser', exact: false }).uncheck();
  await page.getByRole('checkbox', { name: 'Reparatur & Radläden', exact: false }).uncheck();
  await page.getByRole('checkbox', { name: 'Bahnhöfe', exact: false }).uncheck();
  const disabledRequests = pointRequests;
  await jump([15.45,47.075], 15);
  assert.equal(pointRequests, disabledRequests, 'Panning does not fetch disabled water/service points');
  let unavailable = true;
  await page.route('**/maps/cycling.json?**', route => unavailable ? route.fulfill({status:503,body:'Unavailable'}) : route.continue());
  await page.getByRole('checkbox', { name: 'Trinkwasser', exact: false }).check();
  await page.getByRole('alert').filter({ hasText: 'Rad-Infos' }).waitFor();
  unavailable = false;
  await page.locator('.cycling-controls').getByRole('button', { name: 'Erneut laden', exact: true }).click();
  await waitWater();
  await page.locator('.cycling-controls .map-menu__trigger').click();
  await page.setViewportSize({width:390,height:844});
  await page.locator('.cycling-controls .map-menu__trigger').click();
  const panel = await page.locator('.cycling-controls .map-menu__panel').boundingBox();
  assert.ok(panel.x >= 0 && panel.x + panel.width <= 390 && panel.y + panel.height <= 844, 'Overlay controls fit on mobile');
  await page.screenshot({path:`${output}/mobile.png`});
  await page.locator('.cycling-controls .map-menu__trigger').press('Escape');
  assert.equal(await page.locator('.cycling-controls .map-menu__trigger').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert.deepEqual(await page.evaluate(() => window.cyclingMapErrors), []);
  await writeFile(`${output}/browser-report.json`,JSON.stringify({passed:true,points:data.features.length,pointRequests,errors,external},null,2));
  console.log('Cycling overlays: real water data, independent basemaps, point inspection, local requests, persistence, and mobile controls passed.');
} finally { await browser.close(); }

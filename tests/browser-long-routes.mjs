import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const cases = [
  { name: 'Graz-Virgen across map tiles', minimum: 330000, maximum: 350000, coords: [[15.393249918226957,47.076550949654376],[12.456876612333161,47.00334492589846]] },
  { name: '252 km single leg', minimum: 250000, maximum: 260000, coords: [[15.4329,47.075887],[16.5768,48.5707]] },
  { name: '242 km loop', minimum: 240000, maximum: 245000, coords: [[15.4329,47.075887],[15.5404,46.7817],[15.9861,46.688],[15.889,46.953],[16.056,47.281],[15.709,47.104],[15.4329,47.075887]] },
];
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true });
const results = [];

async function ready(page) {
  await page.waitForFunction(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    const map = document.querySelector('.route-layer')?.__vueParentComponent.props.map;
    return store.route?.features.length && !store.pendingSnapCount && !store.pendingLegCount &&
      !store.hasAirLines && ['saved', 'restored'].includes(store.draftStatus) &&
      map?.isSourceLoaded('segments-source') && map.queryRenderedFeatures({ layers: ['segments-routed'] }).length;
  }, null, { timeout: 90000 });
}

async function geometry(page) {
  return page.evaluate(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    return Object.values(store.legs).map(({ coordinates, elevations, surfaces, distanceMeters, ascentMeters }) =>
      ({ coordinates, elevations, surfaces, distanceMeters, ascentMeters }));
  });
}
const hash = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');

try {
  for (const item of cases) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('richiroute.review-basemap', 'local'));
    const page = await context.newPage();
    const errors = [];
    let requests = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname === '/routing/brouter') requests++; });
    await page.goto('http://127.0.0.1:5173/');
    await page.waitForSelector('.route-layer', { state: 'attached' });
    await page.evaluate(coords => {
      const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
      map.fitBounds([[Math.min(...coords.map(c => c[0])), Math.min(...coords.map(c => c[1]))],
        [Math.max(...coords.map(c => c[0])), Math.max(...coords.map(c => c[1]))]], { duration: 0, padding: 60 });
      document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').resetRoute(coords);
    }, item.coords);
    await ready(page);
    assert.equal(requests, item.coords.length * 2 - 1);
    const original = await geometry(page);
    const distance = original.reduce((sum, leg) => sum + leg.distanceMeters, 0);
    assert.ok(distance >= item.minimum && distance <= item.maximum);
    assert.ok(original.reduce((sum, leg) => sum + leg.coordinates.length, 0) > 7000);
    assert.ok(original.every(leg => leg.elevations?.length === leg.coordinates.length && leg.surfaces.length > 0));
    await page.locator('svg[aria-label="Höhenprofil der Route"]').waitFor();
    const originalProfile = await page.locator('.profile .elevation-chart__line').getAttribute('d');

    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'GPX herunterladen', exact: true }).click();
    const gpx = await readFile(await (await downloading).path(), 'utf8');
    const exported = [...gpx.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)">\s*<ele>([^<]+)<\/ele>/g)]
      .map(([,lat,lon,elevation]) => [Number(lon),Number(lat),Number(elevation)]);
    const expected = [];
    for (const leg of original) {
      leg.coordinates.forEach((coord, index) => {
        const previous = expected.at(-1);
        if (index === 0 && previous?.[0] === coord[0] && previous[1] === coord[1] && previous[2] === leg.elevations[index]) return;
        expected.push([...coord, leg.elevations[index]]);
      });
    }
    assert.deepEqual(exported, expected, 'GPX keeps every original coordinate and elevation');

    const initialRequests = requests;
    await page.reload();
    await ready(page);
    assert.equal(requests, initialRequests, 'Reload reuses the complete saved geometry');
    assert.equal(hash(await geometry(page)), hash(original));

    const unaffected = await page.evaluate(() => {
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
      const leg = Object.values(store.legs)[0];
      window.unchangedLegs = Object.values(store.legs).slice(1);
      store.insertShapingPoint(leg.fromId, leg.toId, leg.coordinates[Math.floor(leg.coordinates.length / 2)]);
      return window.unchangedLegs.length;
    });
    await ready(page);
    assert.equal(requests - initialRequests, 3, 'Splitting a long leg uses one snap and two route requests');
    assert.equal(await page.evaluate(() => {
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
      return window.unchangedLegs.filter(leg => store.legs[leg.id] === leg).length;
    }), unaffected, 'Unedited legs retain their geometry objects');
    await page.getByRole('button', { name: /Rückgängig/ }).click();
    await ready(page);
    assert.equal(requests - initialRequests, 3, 'Undo does not recalculate');
    assert.equal(hash(await geometry(page)), hash(original));
    assert.equal(await page.locator('.profile .elevation-chart__line').getAttribute('d'), originalProfile);
    assert.deepEqual(errors, []);
    results.push({ name: item.name, distanceKm: distance / 1000, vertices: exported.length, hash: hash(original), initialRequests, editRequests: 3 });
    console.log(`${item.name}: complete drawing, exact GPX, saved reload, local edit and undo passed.`);
    await context.close();
  }
  await writeFile('experiments/routing/.local/browser-long-routes.json', JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}

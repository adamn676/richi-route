import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: true });
const directory = new URL('../experiments/routing/.local/surface-browser/', import.meta.url);
await mkdir(directory, { recursive: true });

async function ready(page) {
  await page.waitForFunction(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    const map = document.querySelector('.route-layer')?.__vueParentComponent.props.map;
    return store.route?.features.length && !store.pendingSnapCount && !store.pendingLegCount &&
      !store.hasAirLines && ['saved', 'restored'].includes(store.draftStatus) && map?.isSourceLoaded('segments-source');
  }, null, { timeout: 90000 });
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    const { readDraft } = await import('/src/services/draft.service.ts');
    return { legs: JSON.parse(JSON.stringify(store.legs)), points: JSON.parse(JSON.stringify(store.points)),
      draft: await readDraft(), undo: store.undoStack.length, redo: store.redoStack.length };
  });
}

async function checkFocus(page, surface) {
  await page.waitForFunction(() => {
    const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
    return !map.isMoving() && map.isSourceLoaded('surface-focus-source') && map.queryRenderedFeatures({ layers: ['surface-focus-line'] }).length;
  });
  assert.equal(await page.evaluate(async surface => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
    const focus = store.focusedSurface;
    const data = await map.getSource('surface-focus-source').getData();
    return focus.surface === surface && focus.coordinates.every(coord => map.getBounds().contains(coord)) &&
      JSON.stringify(data.features[0].geometry.coordinates) === JSON.stringify(focus.coordinates);
  }, surface), true, 'The map frames and draws exactly the selected section');
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  let requests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/routing/brouter') requests++; });
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForSelector('.route-layer', { state: 'attached' });
  await page.evaluate(() => {
    document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route')
      .resetRoute([[15.393249918226957, 47.076550949654376], [12.456876612333161, 47.00334492589846]]);
  });
  await ready(page);
  assert.equal(requests, 3);
  const original = await snapshot(page);
  const details = page.getByRole('region', { name: 'Untergrund' });
  assert.match(await details.locator('.surfaces__totals').textContent(),
    /^Befestigt293,6\skm.*Vermutlich befestigt44\skm.*Kopfsteinpflaster\/Holzbrücke89\sm.*Unbefestigt364\sm.*Unbekannt232\sm/);
  // Gravel of a few metres at junctions is no section: the unpaved part is one stretch, with nothing to step through.
  await details.getByRole('button', { name: /Unbefestigt/ }).click();
  await checkFocus(page, 'unpaved');
  assert.equal(await details.locator('.surfaces__sections button').count(), 1);
  assert.match(await details.locator('.surfaces__sections').textContent(), /364\sm/);
  const heading = details.locator('.surfaces__step h4');
  assert.equal(await heading.textContent(), 'Unbefestigt · 1 Abschnitt');
  assert.equal(await details.getByRole('button', { name: 'Nächster Abschnitt', exact: true }).count(), 0);
  // Correcting starts where the section is shown.
  const view = () => page.evaluate(() => document.querySelector('.route-layer').__vueParentComponent.props.map.getBounds().toArray().flat().map(n => n.toFixed(6)).join());
  const before = await view();
  await details.getByRole('button', { name: 'Untergrund korrigieren', exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal(await view(), before, 'Starting a correction keeps the map where it is');
  await details.getByRole('button', { name: 'Untergrund korrigieren', exact: true }).click();
  await details.getByRole('button', { name: /Unbefestigt/ }).click();
  await details.getByRole('button', { name: /Unbefestigt/ }).click();
  await checkFocus(page, 'unpaved');
  await page.waitForFunction(() => document.querySelector('.route-layer').__vueParentComponent.props.map.areTilesLoaded());
  await page.screenshot({ path: new URL('desktop.png', directory).pathname });
  await details.getByRole('button', { name: /Vermutlich befestigt/ }).click();
  assert.equal(await details.locator('.surfaces__sections button').count(), 10);
  await details.getByRole('button', { name: 'Weitere Abschnitte', exact: true }).click();
  assert.equal(await details.locator('.surfaces__sections button').count(), 20);
  // The sections one after another, round from the last to the first; the map glides to each.
  const count = Number((await heading.textContent()).match(/^Vermutlich befestigt · 1 von (\d+)$/)[1]);
  await details.getByRole('button', { name: 'Nächster Abschnitt', exact: true }).click();
  assert.equal(await page.evaluate(() => document.querySelector('.route-layer').__vueParentComponent.props.map.isMoving()), true, 'The map glides');
  await checkFocus(page, 'likelyPaved');
  assert.equal(await heading.textContent(), `Vermutlich befestigt · 2 von ${count}`);
  await details.getByRole('button', { name: 'Voriger Abschnitt', exact: true }).click();
  await details.getByRole('button', { name: 'Voriger Abschnitt', exact: true }).click();
  await checkFocus(page, 'likelyPaved');
  assert.equal(await heading.textContent(), `Vermutlich befestigt · ${count} von ${count}`);
  assert.equal(await details.locator('.surfaces__sections button[aria-pressed=true]').count(), 1, 'The list grows to show the last section');
  await details.locator('.surfaces__sections button[aria-pressed=true]').click();
  await page.waitForFunction(async () => {
    const map = document.querySelector('.route-layer').__vueParentComponent.props.map;
    return (await map.getSource('surface-focus-source').getData()).features.length === 0;
  });
  assert.deepEqual(await snapshot(page), original, 'Inspecting surfaces changes neither the draft nor undo history');
  assert.equal(requests, 3, 'Inspecting surfaces sends no routing requests');

  await page.setViewportSize({ width: 390, height: 844 });
  await details.getByRole('button', { name: /Unbefestigt/ }).click();
  await checkFocus(page, 'unpaved');
  await details.locator('.surfaces__sections').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: new URL('mobile.png', directory).pathname });

  await page.getByRole('button', { name: /Rückgängig/ }).click();
  await page.waitForFunction(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    return !store.route && !store.focusedSurface;
  });
  await page.getByRole('button', { name: /Wiederholen/ }).click();
  await ready(page);
  assert.deepEqual((await snapshot(page)).legs, original.legs);
  assert.equal(await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').focusedSurface), null);
  assert.equal(requests, 3);

  await page.reload();
  await ready(page);
  assert.deepEqual((await snapshot(page)).legs, original.legs, 'Reload keeps exact material spans and geometry');
  assert.equal(requests, 3, 'Reload does not reroute');
  assert.equal(await page.getByRole('button', { name: /Unbefestigt/ }).count(), 1);
  assert.deepEqual(errors, []);

  const legacy = JSON.parse(original.draft);
  for (const leg of Object.values(legacy.legs)) for (const span of leg.surfaces) delete span.surfaceTag;
  const legacyContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await legacyContext.addInitScript(draft => localStorage.setItem('richiroute.route-draft.v1', draft), JSON.stringify(legacy));
  const legacyPage = await legacyContext.newPage();
  let legacyRequests = 0;
  legacyPage.on('request', request => { if (new URL(request.url()).pathname === '/routing/brouter') legacyRequests++; });
  legacyPage.on('pageerror', error => errors.push(error.message));
  await legacyPage.goto('http://127.0.0.1:5173/');
  await ready(legacyPage);
  await legacyPage.getByRole('region', { name: 'Untergrund' }).waitFor();
  assert.equal(await legacyPage.getByRole('button', { name: /Unbefestigt/ }).count(), 1);
  assert.equal(legacyRequests, 0, 'Drafts without recorded materials load without rerouting');
  assert.deepEqual(errors, []);
  await writeFile(new URL('result.json', directory), JSON.stringify({ route: 'Graz-Virgen', requests, legacyRequests,
    desktop: '1440x1000', mobile: '390x844', errors, checks: ['exact section highlight', 'likely paved sections', 'pagination',
      'draft unchanged by inspection', 'undo and redo', 'saved reload', 'legacy draft'] }, null, 2));
  console.log('Surface inspection passed on desktop and mobile, including saved and legacy drafts; three routing requests total.');
} finally {
  await browser.close();
}

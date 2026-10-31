import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
import { saveEntry, gpxReady } from './browser-ui.mjs';

const legacyDraftKey = 'richiroute.route-draft.v1';
const origin = 'http://127.0.0.1:5173';
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: process.env.PLAYWRIGHT_HEADED !== '1' });
const errors = [];
async function makeContext(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
  await context.addInitScript(() => {
    if (location.origin === 'http://127.0.0.1:5173') localStorage.setItem('richiroute.review-basemap', 'street');
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return context;
}
async function state(page) {
  return page.evaluate(() => {
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    return { points: s.points, legs: s.legs, distance: s.distanceMeters, draftStatus: s.draftStatus };
  });
}
async function idle(page) {
  await page.waitForFunction(() => {
    const s = document.querySelector('#app').__vue_app__?.config.globalProperties.$pinia._s.get('route');
    return s && !s.pendingSnapCount && !s.pendingLegCount && !s.hasAirLines;
  }, null, { timeout: 90000 });
}
const storedDraft = page => page.evaluate(async () => (await import('/src/services/draft.service.ts')).readDraft());
const storedInput = async page => JSON.parse(await storedDraft(page)).points[0].userInput;
async function saved(page) {
  await page.waitForFunction(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route').draftStatus === 'saved');
}
async function query(page, value) {
  await page.evaluate(value => {
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    s.setWaypointQuery(s.waypoints[0].id, value);
  }, value);
}

try {
  let context = await makeContext();
  let page = await context.newPage();
  await page.goto(origin);
  await page.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();
  assert.equal(await gpxReady(page), false);
  await page.evaluate(() => {
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    s.resetRoute([[15.392482, 47.099327], [15.3428, 47.0759]]);
  });
  await idle(page);
  await page.evaluate(() => {
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    s.insertShapingPoint(s.points[0].id, s.points[1].id, [15.377673, 47.098973]);
  });
  await idle(page);
  await saved(page);
  const original = await state(page);
  assert.equal(original.points.filter(p => p.type === 'shape').length, 1);
  assert.equal(original.distance, 5888);
  const stored = await storedDraft(page);
  const storageState = await context.storageState({ indexedDB: true });
  await context.close();

  context = await makeContext({ storageState });
  let routingRequests = 0;
  await context.route('**/routing/**', route => { routingRequests++; return route.abort(); });
  page = await context.newPage();
  await page.goto(origin);
  await page.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();
  await idle(page);
  const restored = await state(page);
  const durablePoint = ({ id, type, kind, coord, address, userInput }) => ({ id, type, kind, coord, address, userInput });
  assert.deepEqual(restored.points.map(durablePoint), original.points.map(durablePoint));
  assert.deepEqual(restored.legs, original.legs);
  assert.equal(restored.draftStatus, 'restored');
  assert.equal(routingRequests, 0, 'Finished routes restore without touching the engine');
  await page.waitForFunction(async () => {
    const map = document.querySelector('.route-layer')?.__vueParentComponent.props.map;
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    const source = map?.getSource('segments-source');
    return map && !map.isMoving() && source && (await source.getData()).features.length > 0 &&
      s.points.every(p => map.getBounds().contains(p.coord));
  });
  assert.equal(await gpxReady(page), true);

  const downloadEvent = page.waitForEvent('download');
  await (await saveEntry(page, 'GPX')).click();
  const download = await downloadEvent;
  assert.match(download.suggestedFilename(), /^richiroute-\d{4}-\d{2}-\d{2}\.gpx$/);
  const exportPath = 'experiments/routing/.local/editor-restored.gpx';
  await download.saveAs(exportPath);
  const xml = await fs.readFile(exportPath, 'utf8');
  const parsed = await page.evaluate(xml => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return {
      errors: doc.querySelectorAll('parsererror').length,
      namespace: doc.documentElement.namespaceURI,
      version: doc.documentElement.getAttribute('version'),
      points: [...doc.querySelectorAll('trkpt')].map(p => [Number(p.getAttribute('lon')), Number(p.getAttribute('lat'))]),
      elevations: doc.querySelectorAll('ele').length,
    };
  }, xml);
  assert.equal(parsed.errors, 0);
  assert.equal(parsed.namespace, 'http://www.topografix.com/GPX/1/1');
  assert.equal(parsed.version, '1.1');
  const expected = [];
  for (let i = 1; i < original.points.length; i++) {
    const leg = original.legs[`${original.points[i - 1].id}:${original.points[i].id}`];
    for (let j = 0; j < leg.coordinates.length; j++) {
      const c = leg.coordinates[j];
      if (j === 0 && JSON.stringify(expected.at(-1)) === JSON.stringify(c)) continue;
      expected.push(c);
    }
  }
  assert.deepEqual(parsed.points, expected);
  assert.equal(parsed.elevations, expected.length);
  await page.screenshot({ path: 'experiments/routing/.local/editor-saved-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Speichern', exact: true }).scrollIntoViewIfNeeded();
  const box = await page.getByRole('button', { name: 'Speichern', exact: true }).boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
  await page.screenshot({ path: 'experiments/routing/.local/editor-saved-mobile.png', fullPage: true });

  const second = await context.newPage();
  await second.goto(origin);
  await idle(second);
  await query(page, 'Changed in first tab');
  await saved(page);
  await second.getByText(/anderen Registerkarte geändert/).waitFor();
  await query(second, 'My explicit replacement');
  await second.waitForTimeout(300);
  assert.equal(await storedInput(second), 'Changed in first tab');
  await second.getByRole('button', { name: 'Aktuelle Route hier speichern' }).click();
  await saved(second);
  assert.equal(await storedInput(second), 'My explicit replacement');
  await context.close();

  const corrupt = await makeContext({ storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: legacyDraftKey, value: '{broken' }] }] } });
  const corruptPage = await corrupt.newPage();
  await corruptPage.goto(origin);
  await corruptPage.getByText(/bisher gespeicherte wurde nicht überschrieben/).waitFor();
  assert.equal(await storedDraft(corruptPage), '{broken', 'An unreadable legacy draft moves to IndexedDB unchanged');
  await corrupt.close();

  const quota = await makeContext({ storageState });
  await quota.addInitScript(() => {
    if (location.origin !== 'http://127.0.0.1:5173') return;
    const put = IDBObjectStore.prototype.put;
    window.denyDraftSave = true;
    IDBObjectStore.prototype.put = function(...args) {
      if (this.name === 'draft' && window.denyDraftSave) throw new DOMException('Full', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  const quotaPage = await quota.newPage();
  await quotaPage.goto(origin);
  await idle(quotaPage);
  await query(quotaPage, 'Unsaved change');
  await quotaPage.getByText(/Änderungen sind noch nicht gesichert/).waitFor();
  assert.equal(await storedDraft(quotaPage), stored);
  await quotaPage.evaluate(() => { window.denyDraftSave = false; });
  await quotaPage.getByRole('button', { name: 'Aktuelle Route hier speichern' }).click();
  await saved(quotaPage);
  await query(quotaPage, 'Flush immediately on exit');
  await quotaPage.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await storedInput(quotaPage), 'Flush immediately on exit');
  await quotaPage.getByRole('button', { name: 'Neue Route', exact: true }).click();
  await quotaPage.waitForFunction(() => {
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    return s.draftStatus === 'saved' && s.points.every(p => p.coord === null);
  });
  await quotaPage.reload();
  await quotaPage.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();
  assert.ok((await state(quotaPage)).points.every(p => p.coord === null));
  assert.equal(await gpxReady(quotaPage), false);
  await quota.close();
  assert.deepEqual(errors, []);
  console.log('Passed: browser reopening without routing, exact GPX geometry/elevation, mobile export, cross-tab protection, malformed draft, quota recovery, exit flush.');
} finally {
  await browser.close();
}

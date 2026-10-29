import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const output = '.cache/saved-routes';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }), headless: process.env.PLAYWRIGHT_HEADED !== '1' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const errors = [];
let requests = 0;
await context.addInitScript(origin => {
  if (location.origin === origin) localStorage.setItem('richiroute.review-basemap', 'street');
}, origin);
await context.route('**/tiles/**', route => route.fulfill({ status: 200, contentType: 'application/vnd.mapbox-vector-tile', body: Buffer.alloc(0) }));
await context.route('**/routing/**', route => { requests++; return route.abort(); });
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
const page = await context.newPage();
const list = page.locator('.library__list');
const entry = name => list.getByRole('listitem', { name, exact: true });
const idle = () => page.waitForFunction(() => !document.querySelector('.library')?.textContent.includes('Wird aktualisiert'));
const state = () => page.evaluate(async () => {
  const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
  const { serializeDraft } = await import('/src/domain/route-draft.ts');
  return serializeDraft(store.points, store.legs);
});
async function setQuery(value) {
  await page.evaluate(value => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    store.setWaypointQuery(store.points[0].id, value);
  }, value);
}
// Duplicating, renaming and deleting sit in each row's menu.
async function more(row, action) {
  await row.getByRole('button', { name: 'Weitere Aktionen', exact: true }).click();
  await row.page().locator('.v-overlay--active .v-list-item').filter({ hasText: action }).click();
}
async function waitRows(count) {
  await page.waitForFunction(count => document.querySelectorAll('.library__list > [role=listitem]').length === count, count);
  await idle();
}
try {
  await page.goto(origin);
  await page.getByRole('heading', { name: 'RichiRoute', exact: true }).waitFor();
  await idle();
  await page.getByRole('tab', { name: 'Meine Routen', exact: true }).click();
  await page.evaluate(async () => {
    const { routingPolicyVersion } = await import('/src/config/routing-policy.ts');
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route');
    const points = [
      { id: 'stop-a', type: 'stop', kind: 'start', coord: [15.4, 47.1], address: null, userInput: 'Start', isGeocoding: false },
      { id: 'shape-b', type: 'shape', coord: [15.5, 47.2] },
      { id: 'stop-c', type: 'stop', kind: 'end', coord: [15.4, 47.1], address: null, userInput: 'Ziel', isGeocoding: false },
    ];
    const legs = {};
    const length = 31229;
    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1], to = points[i], id = `${from.id}:${to.id}`;
      legs[id] = {
        id, fromId: from.id, toId: to.id, fromCoord: from.coord, toCoord: to.coord,
        coordinates: Array.from({ length }, (_, n) => n === 0 ? from.coord : n === length - 1 ? to.coord : [15.45, 47.15]),
        elevations: Array.from({ length }, (_, n) => 300 + n % 50),
        distanceMeters: 565000, ascentMeters: 2000,
        surfaces: [{ fromIndex: 0, toIndex: length - 1, surface: 'paved', surfaceTag: 'asphalt' }],
        status: 'routed', routingPolicy: routingPolicyVersion,
      };
    }
    store.restoreDraft({ version: 1, points, legs });
  });
  const original = await state();
  await page.getByLabel('Routenname', { exact: true }).fill('Lange Runde');
  await page.getByRole('button', { name: 'Route speichern', exact: true }).click();
  await waitRows(1);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Aktuelle Route sichern', exact: true }).click();
  const download = await downloadEvent;
  await download.saveAs(output + '/roundtrip.richiroute.json');
  const backup = JSON.parse(await readFile(output + '/roundtrip.richiroute.json', 'utf8'));
  assert.deepEqual(backup.draft, JSON.parse(original));

  await setQuery('Ungesicherte Änderung');
  const changed = await state();
  await page.getByRole('button', { name: 'Neue Route', exact: true }).click();
  await waitRows(2);
  assert.ok(JSON.parse(await state()).points.every(p => p.coord === null));
  const recovered = await page.evaluate(async () => {
    const { routeLibrary } = await import('/src/services/route-library.service.ts');
    const summary = (await routeLibrary.list()).find(row => row.name.startsWith('Entwurf ·'));
    return (await routeLibrary.read(summary.id)).payload;
  });
  assert.deepEqual(JSON.parse(recovered), JSON.parse(changed));
  // A new route starts on the Route tab.
  assert.equal(await page.getByRole('tab', { name: 'Route', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: 'Meine Routen', exact: true }).click();
  await entry('Lange Runde').getByRole('button', { name: 'Öffnen', exact: true }).click();
  await idle();
  assert.deepEqual(JSON.parse(await state()), JSON.parse(original));
  assert.equal(requests, 0, 'Opening current geometry makes no routing requests');
  await page.getByRole('button', { name: 'Neue Route', exact: true }).click();
  await idle();
  await page.getByRole('tab', { name: 'Meine Routen', exact: true }).click();
  assert.equal(await list.getByRole('listitem').count(), 2, 'An unchanged saved route needs no recovery duplicate');
  await entry('Lange Runde').getByRole('button', { name: 'Öffnen', exact: true }).click();
  await idle();
  assert.equal(await page.getByRole('tab', { name: 'Route', exact: true }).getAttribute('aria-selected'), 'true', 'An opened route shows on the Route tab');

  await setQuery('Gesicherte Änderung');
  await page.getByRole('tab', { name: 'Meine Routen', exact: true }).click();
  await page.getByRole('button', { name: 'Änderungen speichern', exact: true }).click();
  await idle();
  assert.equal(await list.getByRole('listitem').count(), 2, 'Saving an opened route updates it');
  const edited = await state();
  await more(entry('Lange Runde'), 'Duplizieren');
  await waitRows(3);
  await more(entry('Lange Runde (Kopie)'), 'Umbenennen');
  await page.getByLabel('Neuer Routenname', { exact: true }).fill('Zweite Runde');
  await page.getByRole('button', { name: 'Namen speichern', exact: true }).click();
  await entry('Zweite Runde').waitFor();
  await more(entry('Zweite Runde'), 'Löschen');
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  assert.equal(await list.getByRole('listitem').count(), 3);
  await more(entry('Zweite Runde'), 'Löschen');
  await page.getByRole('button', { name: 'Endgültig löschen', exact: true }).click();
  await waitRows(2);
  assert.deepEqual(JSON.parse(await state()), JSON.parse(edited));

  await page.getByLabel('RichiRoute-Sicherung auswählen', { exact: true }).setInputFiles(output + '/roundtrip.richiroute.json');
  await waitRows(3);
  assert.deepEqual(JSON.parse(await state()), JSON.parse(edited), 'Import adds a route without replacing the current draft');
  await page.getByLabel('RichiRoute-Sicherung auswählen', { exact: true }).setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await page.getByRole('alert').filter({ hasText: 'Ungültige oder nicht unterstützte' }).waitFor();
  assert.equal(await list.getByRole('listitem').count(), 3);
  assert.deepEqual(JSON.parse(await state()), JSON.parse(edited));
  await page.reload();
  await page.getByRole('tab', { name: 'Meine Routen', exact: true }).click();
  await waitRows(3);
  assert.deepEqual(JSON.parse(await state()), JSON.parse(edited));
  assert.equal(requests, 0);

  // Real IndexedDB transactions must reject stale mutations and roll back both stores on failure.
  const storageChecks = await page.evaluate(async () => {
    const { routeLibrary } = await import('/src/services/route-library.service.ts');
    const first = (await routeLibrary.list()).find(r => r.name === 'Lange Runde');
    const saved = await routeLibrary.read(first.id);
    const updated = await routeLibrary.rename(first, 'Andere Registerkarte');
    const stale = await Promise.allSettled([
      routeLibrary.save('Veralteter Stand', saved.payload, first),
      routeLibrary.remove(first),
      routeLibrary.rename(first, 'Veralteter Name'),
    ]);
    const untouched = await routeLibrary.read(first.id);
    const count = (await routeLibrary.list()).length;
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function(...args) {
      if (this.name === 'payloads') throw new DOMException('Full', 'QuotaExceededError');
      return add.apply(this, args);
    };
    let failed = false;
    try { await routeLibrary.save('Nicht gespeichert', saved.payload); }
    catch { failed = true; }
    finally { IDBObjectStore.prototype.add = add; }
    return { stale: stale.map(r => r.status), name: untouched.summary.name,
      samePayload: untouched.payload === saved.payload, failed, countBefore: count,
      countAfter: (await routeLibrary.list()).length, revisionChanged: first.revision !== updated.revision };
  });
  assert.deepEqual(storageChecks.stale, ['rejected', 'rejected', 'rejected']);
  assert.equal(storageChecks.name, 'Andere Registerkarte');
  assert.equal(storageChecks.samePayload, true);
  assert.equal(storageChecks.failed, true);
  assert.equal(storageChecks.countBefore, storageChecks.countAfter);
  assert.equal(storageChecks.revisionChanged, true);

  const largeStorage = await page.evaluate(async () => {
    const { routeLibrary } = await import('/src/services/route-library.service.ts');
    const saved = await routeLibrary.read((await routeLibrary.list())[0].id);
    const data = JSON.parse(saved.payload);
    const leg = Object.values(data.legs)[0];
    const length = 400000;
    leg.coordinates = Array.from({ length }, (_, i) => i === 0 ? leg.fromCoord : i === length - 1 ? leg.toCoord : [15.45123456789, 47.15123456789]);
    leg.elevations = Array.from({ length }, () => 300);
    leg.surfaces = [{ fromIndex: 0, toIndex: length - 1, surface: 'paved' }];
    const payload = JSON.stringify(data);
    const summary = await routeLibrary.save('Großer Speichertest', payload);
    const restored = await routeLibrary.read(summary.id);
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(stores, ...args) {
      if ([stores].flat().includes('payloads')) throw new Error('List loaded route geometry');
      return transaction.call(this, stores, ...args);
    };
    let listed;
    try { listed = (await routeLibrary.list()).some(row => row.id === summary.id); }
    finally { IDBDatabase.prototype.transaction = transaction; }
    await routeLibrary.remove(summary);
    return { bytes: new Blob([payload]).size, exact: restored.payload === payload, listed };
  });
  assert.ok(largeStorage.bytes > 5 * 1024 * 1024);
  assert.equal(largeStorage.exact, true);
  assert.equal(largeStorage.listed, true);

  // A failed recovery save must leave the displayed draft untouched.
  await page.evaluate(() => {
    window.originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function(...args) {
      if (this.name === 'payloads') throw new DOMException('Full', 'QuotaExceededError');
      return window.originalAdd.apply(this, args);
    };
  });
  const beforeFailure = await state();
  await page.getByRole('button', { name: 'Neue Route', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Browserspeicher ist voll' }).waitFor();
  assert.deepEqual(JSON.parse(await state()), JSON.parse(beforeFailure));
  await page.evaluate(() => { IDBObjectStore.prototype.add = window.originalAdd; });
  await page.getByRole('button', { name: 'Aktualisieren', exact: true }).click();
  await idle();

  // Edits made while a recovery transaction is pending must not be replaced on completion.
  await page.evaluate(() => {
    window.originalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(stores, ...args) {
      const tx = window.originalTransaction.call(this, stores, ...args);
      if (stores.includes('payloads')) {
        IDBDatabase.prototype.transaction = window.originalTransaction;
        tx.addEventListener('complete', event => {
          event.stopImmediatePropagation();
          window.releaseRecovery = () => tx.oncomplete.call(tx, event);
        }, { once: true });
      }
      return tx;
    };
  });
  await page.getByRole('button', { name: 'Neue Route', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.releaseRecovery));
  await setQuery('Bearbeitung während des Wechsels');
  const duringSwitch = await state();
  await page.evaluate(() => window.releaseRecovery());
  await page.getByRole('alert').filter({ hasText: 'während des Speicherns geändert' }).waitFor();
  assert.deepEqual(JSON.parse(await state()), JSON.parse(duringSwitch));

  const second = await context.newPage();
  await second.goto(origin);
  await second.getByRole('tab', { name: 'Meine Routen', exact: true }).click();
  await second.locator('.library__list > [role=listitem]').first().waitFor();
  const secondEntry = second.locator('.library__list').getByRole('listitem', { name: 'Andere Registerkarte', exact: true });
  await more(secondEntry, 'Umbenennen');
  await second.getByLabel('Neuer Routenname', { exact: true }).fill('In anderem Tab umbenannt');
  await second.getByRole('button', { name: 'Namen speichern', exact: true }).click();
  await entry('In anderem Tab umbenannt').waitFor();
  await second.close();

  // A route saved before stops were named gets street names on opening, and that alone is no change to protect.
  await context.route('**/geocoding/reverse**', route => route.fulfill({ json: { features: [{ type: 'Feature',
    geometry: { type: 'Point', coordinates: [15.4, 47.1] }, properties: { type: 'street', name: 'Testweg', postcode: '8010', city: 'Graz' } }] } }));
  const unnamedPayload = await page.evaluate(async () => {
    const { routeLibrary } = await import('/src/services/route-library.service.ts');
    const saved = await routeLibrary.read((await routeLibrary.list()).find(row => row.name === 'In anderem Tab umbenannt').id);
    const data = JSON.parse(saved.payload);
    data.points = data.points.map(point => point.type === 'stop' ? { ...point, address: null, userInput: '' } : point);
    await routeLibrary.save('Ohne Straßennamen', JSON.stringify(data));
    return JSON.stringify(data);
  });
  await page.getByRole('button', { name: 'Aktualisieren', exact: true }).click();
  await entry('Ohne Straßennamen').getByRole('button', { name: 'Öffnen', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route')
    .waypoints.every(point => point.address === 'Testweg, 8010 Graz' && point.userInput === point.address));
  await idle();
  await page.getByRole('tab', { name: 'Meine Routen', exact: true }).click();
  const rows = await list.getByRole('listitem').count();
  await page.getByRole('button', { name: 'Neue Route', exact: true }).click();
  await idle();
  await page.getByRole('tab', { name: 'Meine Routen', exact: true }).click();
  assert.equal(await list.getByRole('listitem').count(), rows, 'Filled-in street names need no recovery copy');
  assert.equal(await page.evaluate(async () => {
    const { routeLibrary } = await import('/src/services/route-library.service.ts');
    return (await routeLibrary.read((await routeLibrary.list()).find(row => row.name === 'Ohne Straßennamen').id)).payload;
  }), unnamedPayload, 'The saved route changes only when saved');

  await page.locator('.library').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: output + '/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.library').scrollIntoViewIfNeeded();
  for (const button of await page.locator('.library button:visible').all()) {
    const box = await button.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, 'Saved-route controls fit mobile width');
  }
  await page.screenshot({ path: output + '/mobile.png', fullPage: true });
  await page.locator('#panel-library .section-heading').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: output + '/mobile-list.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Saved routes: long-route fidelity, update/copy/rename/delete, recovery, backup import/export, reload, cross-tab conflicts, atomic rollback and mobile controls passed.');
} finally {
  await context.close();
  await browser.close();
}

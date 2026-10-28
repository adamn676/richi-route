import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { parseDraft, serializeDraft } from '../src/domain/route-draft.ts';
import { exportGpx, gpxUnavailableReason } from '../src/domain/route-gpx.ts';
import { useRouteStore } from '../src/stores/route.store.ts';
import { routingEngine } from '../src/services/route.service.ts';
import { routingPolicyVersion } from '../src/config/routing-policy.ts';

function fixture() {
  const points = [
    { id: 'stop-a', type: 'stop', kind: 'start', coord: [15.4, 47.1], address: 'Start & <Fluss>', userInput: 'Start & <Fluss>', isGeocoding: false },
    { id: 'shape-b', type: 'shape', coord: [15.402, 47.102] },
    { id: 'stop-c', type: 'stop', kind: 'end', coord: [15.4, 47.1], address: null, userInput: '', isGeocoding: false },
  ];
  const legs = {};
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1], to = points[i], id = `${from.id}:${to.id}`;
    legs[id] = {
      id, fromId: from.id, toId: to.id, fromCoord: [...from.coord], toCoord: [...to.coord],
      coordinates: [[...from.coord], [15.401, 47.101], [...to.coord]],
      elevations: i === 1 ? [300, 305, 310] : [310, 305, 300],
      distanceMeters: 250, ascentMeters: i === 1 ? 10 : 0,
      surfaces: [{ fromIndex: 0, toIndex: 2, surface: 'paved' }], status: 'routed',
    };
  }
  return { points, legs, pendingLegCount: 0, pendingSnapCount: 0 };
}

test('draft round-trip retains ordered shaping points, loop geometry, labels, surfaces and elevation', () => {
  const route = fixture();
  const parsed = parseDraft(serializeDraft(route.points, route.legs));
  assert.deepEqual(parsed.points, route.points);
  assert.deepEqual(parsed.legs, route.legs);
});

test('invalid, future-version and stale drafts are rejected instead of restoring a false route', () => {
  for (const mutate of [
    d => { d.version = 2; },
    d => { d.points[1].coord = [NaN, 47]; },
    d => { d.points[1].id = d.points[0].id; },
    d => { d.points[0].kind = 'end'; },
    d => { d.legs['stop-a:shape-b'].fromCoord = [16, 48]; },
    d => { d.legs['stop-a:shape-b'].coordinates[0] = [16, 48]; },
    d => { d.legs['stop-a:shape-b'].elevations = [300]; },
    d => { d.legs['stop-a:shape-b'].surfaces[0].toIndex = 100; },
    d => { d.legs.unrelated = d.legs['stop-a:shape-b']; },
  ]) {
    const draft = { version: 1, ...fixture() };
    mutate(draft);
    assert.throws(() => parseDraft(JSON.stringify(draft)));
  }
  assert.throws(() => parseDraft('{broken'));
});

test('restoring a finished draft makes no routing calls and keeps its exact roads', t => {
  setActivePinia(createPinia());
  const route = fixture();
  t.mock.method(routingEngine, 'routeLeg', () => { throw new Error('Unexpected reroute'); });
  t.mock.method(routingEngine, 'snap', () => { throw new Error('Unexpected snap'); });
  const store = useRouteStore();
  store.restoreDraft(parseDraft(serializeDraft(route.points, route.legs)));
  assert.deepEqual(store.legs, route.legs);
  assert.equal(store.pendingLegCount, 0);
  assert.equal(store.canUndo, false);
  assert.equal(routingEngine.routeLeg.mock.callCount(), 0);
  assert.equal(routingEngine.snap.mock.callCount(), 0);
});

test('a changed routing policy recalculates cached legs while keeping the saved route visible', async t => {
  setActivePinia(createPinia());
  const route = fixture();
  for (const leg of Object.values(route.legs)) leg.routingPolicy = 'previous-policy';
  const complete = [];
  t.mock.method(routingEngine, 'routeLeg', (from, to) => new Promise(resolve => complete.push(() => resolve({
    coordinates: [from, to], distanceMeters: 200, ascentMeters: 0, elevations: null, surfaces: [], routingPolicy: routingPolicyVersion,
  }))));
  const store = useRouteStore();
  store.restoreDraft(parseDraft(serializeDraft(route.points, route.legs)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(complete.length, 2);
  assert.deepEqual(store.legs, route.legs, 'Existing geometry stays visible during replacement');
  for (const finish of complete) finish();
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(Object.values(store.legs).every(leg => leg.routingPolicy === routingPolicyVersion));
  const saved = parseDraft(serializeDraft(store.points, store.legs));
  store.restoreDraft(saved);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(complete.length, 2, 'The current revision reuses completed geometry');
});

test('an interrupted snap resumes after restoration and finishes its missing leg', async t => {
  setActivePinia(createPinia());
  const route = fixture();
  route.points.splice(1, 1);
  route.points[1].coord = [15.403, 47.103];
  route.points[1].snapPending = true;
  t.mock.method(routingEngine, 'snap', async coord => coord);
  t.mock.method(routingEngine, 'routeLeg', async (from, to) => ({
    coordinates: [from, to], distanceMeters: 300, ascentMeters: null, elevations: null, surfaces: [],
  }));
  const store = useRouteStore();
  store.restoreDraft(parseDraft(serializeDraft(route.points, {})));
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(routingEngine.snap.mock.callCount(), 1);
  assert.equal(routingEngine.routeLeg.mock.callCount(), 1);
  assert.equal(store.pendingSnapCount, 0);
  assert.equal(store.hasAirLines, false);
});

test('GPX keeps the return leg, removes only the shared join, and writes latitude before longitude with elevation', () => {
  const route = fixture();
  const gpx = exportGpx(route, 'Mur & <Runde>\u0000');
  assert.match(gpx, /<name>Mur &amp; &lt;Runde&gt;<\/name>/);
  assert.ok(!gpx.includes('\u0000'));
  assert.equal((gpx.match(/<trkpt /g) ?? []).length, 5);
  assert.equal((gpx.match(/<trkseg>/g) ?? []).length, 1);
  assert.equal((gpx.match(/lat="47.1000000" lon="15.4000000"/g) ?? []).length, 2);
  assert.match(gpx, /lat="47.1020000" lon="15.4020000"><ele>310.00<\/ele>/);
  assert.ok(!gpx.includes('<rte>'));
});

test('GPX omits unknown elevation, preserves small segment gaps and refuses incomplete work', () => {
  const route = fixture();
  route.legs['shape-b:stop-c'].coordinates[0][0] += 0.000001;
  route.legs['shape-b:stop-c'].elevations = null;
  const gpx = exportGpx(route);
  assert.equal((gpx.match(/<trkseg>/g) ?? []).length, 2);
  assert.equal((gpx.match(/<ele>/g) ?? []).length, 3);
  for (const mutate of [
    d => { d.pendingLegCount = 1; },
    d => { d.pendingSnapCount = 1; },
    d => { d.points[1].coord = null; },
    d => { delete d.legs['stop-a:shape-b']; },
    d => { d.legs['stop-a:shape-b'].status = 'air'; },
    d => { d.legs['stop-a:shape-b'].coordinates[0] = [16, 48]; },
  ]) {
    const incomplete = fixture();
    mutate(incomplete);
    assert.ok(gpxUnavailableReason(incomplete));
    assert.throws(() => exportGpx(incomplete));
  }
});

test('a shared join retains known elevation when the preceding leg has none', () => {
  const route = fixture();
  route.legs['stop-a:shape-b'].elevations = null;
  const gpx = exportGpx(route);
  assert.equal((gpx.match(/<ele>/g) ?? []).length, 3);
  assert.equal((gpx.match(/<trkseg>/g) ?? []).length, 1);
  assert.match(gpx, /lat="47.1020000" lon="15.4020000"><ele>310.00<\/ele>/);
});

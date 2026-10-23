import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { useRouteStore } from '../src/stores/route.store.ts';
import { routingEngine } from '../src/services/route.service.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 15; i++) await tick(); }
function response(coords) {
  return new Response(JSON.stringify({ features: [{ geometry: { type: 'LineString', coordinates: coords }, properties: { 'track-length': coords.length === 1 ? '0' : '100' } }] }));
}
function intercept(t, hold = () => false) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const parsed = new URL(url, 'http://localhost');
    assert.equal(parsed.pathname, '/routing/brouter');
    assert.equal(parsed.searchParams.get('profile'), 'richi-local-v1');
    assert.equal(parsed.searchParams.has('nogos'), false);
    const coords = parsed.searchParams.get('lonlats').split('|').map(pair => pair.split(',').map(Number));
    const snap = JSON.stringify(coords[0]) === JSON.stringify(coords[1]);
    return new Promise((resolve, reject) => {
      const request = { coords, snap, signal: options.signal, resolve: (value = response(snap ? [coords[0]] : coords)) => resolve(value), reject };
      requests.push(request);
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      if (!hold(request)) request.resolve();
    });
  });
  return requests;
}

test('loading a route with shaping points is one undoable action', async t => {
  setActivePinia(createPinia());
  intercept(t);
  const store = useRouteStore();
  store.resetRoute([[15.4, 47], [15.5, 47]]);
  await settle();
  const previous = JSON.stringify(store.points);
  store.resetRoute([[15.41, 47], [15.42, 47], [15.43, 47], [15.44, 47]], [1]);
  await settle();
  assert.deepEqual(store.points.map(p => p.type), ['stop', 'shape', 'stop', 'stop']);
  assert.deepEqual(store.waypoints.map(p => p.kind), ['start', 'via', 'end']);
  assert.equal(Object.keys(store.legs).length, 3);
  store.undo();
  await settle();
  assert.equal(JSON.stringify(store.points), previous);
  store.redo();
  await settle();
  assert.equal(store.shapingPoints.length, 1);
  assert.equal(store.hasAirLines, false);
});

test('action proxies share one routing queue and undo cancels their pending requests', async t => {
  setActivePinia(createPinia());
  let hold = false;
  const requests = intercept(t, request => hold && request.snap);
  const store = useRouteStore();
  for (const name of ['resetRoute', '_snapPoint', '_reconcile', 'undo']) {
    const action = store[name];
    store[name] = function (...args) { return action.apply(new Proxy(store, {}), args); };
  }
  store.resetRoute(Array.from({ length: 9 }, (_, i) => [15.4 + i / 1000, 47]), [1, 2, 3]);
  await settle();
  assert.equal(requests.filter(r => r.snap).length, 9);
  assert.equal(requests.filter(r => !r.snap).length, 8, 'Each leg is calculated once');
  const previous = JSON.stringify(store.points);
  hold = true;
  store.resetRoute([[15.5, 47], [15.6, 47]]);
  await tick();
  const pending = requests.filter(r => r.snap && !r.signal.aborted).slice(-2);
  store.undo();
  await settle();
  assert.ok(pending.every(r => r.signal.aborted), 'Undo cancels work started by a different action proxy');
  assert.equal(JSON.stringify(store.points), previous);
  assert.equal(store.pendingSnapCount, 0);
  assert.equal(store.pendingLegCount, 0);
});

test('invalid shaping indices leave the current route and undo history intact', async t => {
  setActivePinia(createPinia());
  intercept(t);
  const store = useRouteStore();
  const coords = [[15.4, 47], [15.45, 47], [15.5, 47]];
  store.resetRoute(coords);
  await settle();
  const before = JSON.stringify({ points: store.points, history: store.undoStack });
  for (const index of [-1, 0, 2, 3, 1.5, NaN]) {
    assert.throws(() => store.resetRoute(coords, [index]));
    assert.equal(JSON.stringify({ points: store.points, history: store.undoStack }), before);
  }
});

test('undoing an insertion resumes an interrupted snap; redo stays consistent', async t => {
  setActivePinia(createPinia());
  let hold = false;
  const requests = intercept(t, request => hold && request.snap);
  const store = useRouteStore();
  store.resetRoute([[15.4, 47], [15.5, 47], [15.6, 47]]);
  await settle();
  const end = store.waypoints[1].id;
  hold = true;
  store.updateWaypointCoord(end, [15.51, 47]);
  await tick();
  const interrupted = requests.at(-1);
  store.addIntermediateStopAndPrepare();
  store.undo();
  await settle();
  assert.equal(interrupted.signal.aborted, true);
  const resumed = requests.at(-1);
  assert.notEqual(resumed, interrupted);
  assert.equal(resumed.snap, true);
  assert.equal(store.pendingSnapCount, 1);
  resumed.resolve(response([[15.51001, 47]]));
  await settle();
  assert.deepEqual(store.waypoints[1].coord, [15.51001, 47]);
  assert.equal(store.pendingSnapCount, 0);
  assert.equal(store.hasAirLines, false);
  hold = false;
  store.redo();
  await settle();
  assert.equal(store.waypoints.length, 4);
  assert.equal(store.pendingSnapCount, 0);
  assert.equal(store.hasAirLines, false);
});

test('failed snap never routes raw coordinates; retry recovers explicitly', async t => {
  setActivePinia(createPinia());
  let fail = true;
  const requests = intercept(t, request => {
    if (request.snap && fail) { request.resolve(new Response('', { status: 503 })); return true; }
    return false;
  });
  t.mock.method(console, 'error', () => {});
  const store = useRouteStore();
  store.resetRoute([[15.4, 47], [15.5, 47]]);
  await settle();
  assert.equal(requests.filter(request => !request.snap).length, 0);
  assert.equal(store.hasAirLines, true);
  assert.equal(store.pendingSnapCount, 0);
  assert.ok(store.waypoints.every(point => point.snapError));
  fail = false;
  store.retryRouting();
  await settle();
  assert.equal(store.hasAirLines, false);
  assert.equal(store.errorMessage, null);
});

test('a failed leg preserves the routing explanation and retry clears it', async t => {
  setActivePinia(createPinia());
  let fail = true;
  intercept(t, request => {
    if (!request.snap && fail) {
      request.resolve(new Response('datafile E10_N45.rd5 not found', { status: 400 }));
      return true;
    }
    return false;
  });
  t.mock.method(console, 'error', () => {});
  const store = useRouteStore();
  store.resetRoute([[15.4, 47], [15.5, 47]]);
  await settle();
  assert.match(store.errorMessage, /Kartendaten \(E10_N45\.rd5\)/);
  assert.equal(Object.values(store.legs)[0].error, store.errorMessage);
  assert.equal(store.hasAirLines, true);
  fail = false;
  store.retryRouting();
  await settle();
  assert.equal(store.errorMessage, null);
  assert.equal(store.hasAirLines, false);
});

test('editing one stop preserves distant geometry and undo restores the edited geometry', async t => {
  setActivePinia(createPinia());
  const requests = intercept(t);
  const store = useRouteStore();
  store.resetRoute([[15.4, 47], [15.41, 47], [15.42, 47], [15.43, 47], [15.44, 47]]);
  await settle();
  const before = Object.values(store.legs);
  const count = requests.length;
  store.updateWaypointCoord(store.waypoints[2].id, [15.421, 47]);
  await settle();
  assert.equal(requests.length - count, 3); // One snap and two adjacent legs.
  assert.equal(Object.values(store.legs)[0], before[0]);
  assert.equal(Object.values(store.legs)[3], before[3]);
  store.undo();
  await settle();
  assert.deepEqual(Object.values(store.legs), before);
  assert.equal(requests.length - count, 3);
});

test('snap and route calls share a six-request limit; queued cancellation sends no HTTP request', async t => {
  const requests = intercept(t, () => true);
  const controllers = Array.from({ length: 10 }, () => new AbortController());
  const promises = controllers.map((controller, i) => (i % 2
    ? routingEngine.routeLeg([15.4, 47], [15.5, 47], controller.signal)
    : routingEngine.snap([15.4, 47], controller.signal)));
  const done = Promise.allSettled(promises);
  await settle();
  assert.equal(requests.length, 6);
  controllers[9].abort();
  for (let i = 0; i < 9; i++) {
    requests[i].resolve();
    await settle();
    assert.ok(requests.length <= Math.min(i + 7, 9));
  }
  const results = await done;
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 9);
  assert.equal(requests.length, 9);
});

test('a leg landing on a parallel road at an interior point stays an explicit gap', async t => {
  setActivePinia(createPinia());
  intercept(t, request => {
    if (request.snap) return false;
    const coords = structuredClone(request.coords);
    if (coords[1][0] === 15.5) coords[1][0] += .001;
    request.resolve(response(coords));
    return true;
  });
  const store = useRouteStore();
  store.resetRoute([[15.4, 47], [15.5, 47], [15.6, 47]]);
  await settle();
  assert.equal(store.hasAirLines, true);
  assert.match(store.errorMessage, /anderen Weg/);
  assert.deepEqual(store.waypoints[1].coord, [15.5, 47]);
});

test('reachable outer endpoint is shown at its actual road position without a fake connector', async t => {
  setActivePinia(createPinia());
  intercept(t, request => {
    if (request.snap) return false;
    request.resolve(response([[15.401, 47], request.coords[1]]));
    return true;
  });
  const store = useRouteStore();
  store.resetRoute([[15.4, 47], [15.5, 47]]);
  await settle();
  assert.equal(store.hasAirLines, false);
  assert.deepEqual(store.waypoints[0].coord, [15.401, 47]);
  assert.deepEqual(Object.values(store.legs)[0].fromCoord, [15.401, 47]);
});

test('outer routing uses the original click even when preliminary snapping chooses a nearby road', async t => {
  setActivePinia(createPinia());
  const requests = intercept(t, request => {
    if (request.snap && request.coords[0][0] === 15.4) {
      request.resolve(response([[15.4001, 47]]));
      return true;
    }
    return false;
  });
  const store = useRouteStore();
  store.resetRoute([[15.4, 47], [15.5, 47]]);
  await settle();
  const route = requests.find(request => !request.snap);
  assert.deepEqual(route.coords[0], [15.4, 47]);
  assert.deepEqual(store.waypoints[0].coord, [15.4, 47]);
  assert.equal(store.hasAirLines, false);
});

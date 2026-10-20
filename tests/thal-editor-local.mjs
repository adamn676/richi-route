// Requires the local editor server and its prepared BRouter data.
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useRouteStore } from '../src/stores/route.store.ts';
import { routingEngine } from '../src/services/route.service.ts';

const fetchLocal = globalThis.fetch;
globalThis.fetch = (url, options) => fetchLocal(new URL(url, 'http://127.0.0.1:5173'), options);
const signal = AbortSignal.timeout(90000);
const start = [15.392482, 47.099327], end = [15.3428, 47.0759];
const pathPoint = [15.377673, 47.098973];

async function idle(store) {
  while (store.pendingSnapCount || store.pendingLegCount || (store.hasAirLines && !store.errorMessage)) {
    signal.throwIfAborted();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(store.errorMessage, null);
  assert.equal(store.hasAirLines, false);
}

try {
  for (const [from, to] of [[start, end], [end, start]]) {
    const leg = await routingEngine.routeLeg(from, to, signal);
    assert.equal(leg.distanceMeters, 5883);
  }
  const short = await routingEngine.routeLeg([15.377892, 47.099181], [15.377421, 47.098681], signal);
  assert.equal(short.distanceMeters, 66);
  assert.deepEqual(await routingEngine.snap(pathPoint, signal), pathPoint);

  setActivePinia(createPinia());
  const store = useRouteStore();
  store.resetRoute([start, end]);
  await idle(store);
  assert.equal(store.distanceMeters, 5883);
  store.insertShapingPoint(store.points[0].id, store.points[1].id, pathPoint);
  await idle(store);
  assert.deepEqual(store.shapingPoints[0].coord, pathPoint);
  assert.equal(Object.values(store.legs).length, 2);
  for (const leg of Object.values(store.legs)) {
    assert.ok(leg.coordinates.some(([x, y]) => x === pathPoint[0] && y === pathPoint[1]));
  }
  const selectedDistance = store.distanceMeters;
  store.undo();
  await idle(store);
  assert.equal(store.shapingPoints.length, 0);
  assert.equal(store.distanceMeters, 5883);
  console.log(JSON.stringify({ automaticMeters: 5883, selectedMeters: selectedDistance, shortPathMeters: 66, snap: 'preserved', undo: 'passed' }));
} finally {
  globalThis.fetch = fetchLocal;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { markRaw } from 'vue';
import { useRouteStore } from '../src/stores/route.store.ts';
import { useRouteProfileStore } from '../src/stores/route-profile.store.ts';

function setup() {
  setActivePinia(createPinia());
  const route = useRouteStore();
  const points = [[15, 47], [15.01, 47], [16, 48]].map((coord, i) => ({
    id: String(i), type: 'stop', kind: i === 0 ? 'start' : i === 2 ? 'end' : 'via', coord,
    address: null, userInput: '', isGeocoding: false,
  }));
  const leg = (id, from, to, coordinates, elevations) => markRaw({
    id, fromId: String(from), toId: String(to), fromCoord: points[from].coord, toCoord: points[to].coord,
    status: 'routed', coordinates, elevations, distanceMeters: 1, ascentMeters: 1, surfaces: [],
  });
  route.$patch({ points, legs: {
    '0:1': leg('0:1', 0, 1, [[15, 47], [15.01, 47]], [100, 200]),
    '1:2': leg('1:2', 1, 2, [[16, 48], [16.01, 48]], [400, 500]),
  } });
  return { route, inspection: useRouteProfileStore() };
}

test('planned-route inspection interpolates the map position without changing route or cached profile', t => {
  const { route, inspection } = setup();
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Hover must not request routing'); });
  const before = JSON.stringify(route.$state), track = inspection.track;
  inspection.focusAt(track.distances[0].at(-1) / 2);
  assert.ok(Math.abs(inspection.focus.coordinate[0] - 15.005) < 1e-10);
  assert.equal(inspection.focus.elevation, 150);
  assert.strictEqual(inspection.track, track);
  assert.equal(JSON.stringify(route.$state), before);
  inspection.focusAt(null); assert.equal(inspection.focus, null);
});

test('profile positions respect leg gaps and invalidate synchronously after route replacement or pending work', () => {
  const { route, inspection } = setup();
  inspection.focusAt(inspection.track.distances[1][0]);
  assert.deepEqual(inspection.focus.coordinate, [16, 48]);
  route.legs = { ...route.legs, '1:2': markRaw({ ...route.legs['1:2'], elevations: [600, 700] }) };
  assert.equal(inspection.focus, null);
  inspection.focusAt(0);
  route.pendingLegCount = 1;
  assert.equal(inspection.focus, null); assert.equal(inspection.track, null);
  route.pendingLegCount = 0;
  assert.equal(inspection.focus, null);
  route.legs = { ...route.legs, '1:2': { ...route.legs['1:2'], status: 'air' } };
  assert.equal(inspection.track, null);
});

test('unknown heights remain inspectable without inventing elevation or gradient', () => {
  const { route, inspection } = setup();
  route.legs = Object.fromEntries(Object.entries(route.legs).map(([id, leg]) => [id, markRaw({ ...leg, elevations: null })]));
  inspection.focusAt(0);
  assert.deepEqual(inspection.focus.coordinate, [15, 47]);
  assert.equal(inspection.focus.elevation, null); assert.equal(inspection.focus.gradient, null);
});

test('a long planned route keeps the elevation drawing bounded', () => {
  const { route, inspection } = setup();
  const coordinates = Array.from({ length: 100000 }, (_, i) => [15 + i / 10000000, 47]);
  route.legs = { ...route.legs, '0:1': markRaw({ ...route.legs['0:1'], coordinates, elevations: coordinates.map((_, i) => 100 + i % 20) }) };
  assert.ok(inspection.track.profile.path.length < 25000);
  inspection.focusAt(inspection.track.distances[0][50000]);
  assert.deepEqual(inspection.focus.coordinate, coordinates[50000]);
});

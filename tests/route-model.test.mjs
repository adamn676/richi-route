import assert from 'node:assert/strict';
import test from 'node:test';
import {
  airLeg,
  insertBetween,
  legId,
  LegScheduler,
  reconcileLegs,
} from '../src/domain/route-model.ts';
import { getSegments } from '../src/utils/geometry.ts';

const stop = (id, coord, kind = 'via') => ({
  id,
  type: 'stop',
  kind,
  coord,
  address: null,
  userInput: '',
  isGeocoding: false,
});
const shape = (id, coord) => ({ id, type: 'shape', coord });

test('forty queued legs keep at most six engine jobs active, including ignored aborts', async () => {
  const initial = reconcileLegs(Array.from({ length: 41 }, (_, i) => stop(String(i), [15 + i * .001, 47])), {});
  const jobs = [];
  let active = 0, peak = 0;
  const scheduler = new LegScheduler((from, to, signal) => new Promise(resolve => {
    peak = Math.max(peak, ++active);
    jobs.push({ signal, resolve: () => { active--; resolve({ coordinates: [from, to], distanceMeters: 100, ascentMeters: null, elevations: null, surfaces: [] }); } });
  }), () => {}, () => assert.fail(), () => {});
  scheduler.update(initial.legs, initial.requests);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.length, 6);
  scheduler.cancelAll();
  scheduler.update(initial.legs, initial.requests);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.length, 6);
  assert.ok(jobs.every(job => job.signal.aborted));
  for (let i = 0; i < 46; i++) {
    jobs[i].resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(peak, 6);
  assert.equal(active, 0);
});

function routed(request, vertices = 4) {
  return {
    ...airLeg(request),
    coordinates: Array.from({ length: vertices }, (_, index) => [
      request.fromCoord[0] + ((request.toCoord[0] - request.fromCoord[0]) * index) / (vertices - 1),
      request.fromCoord[1] + ((request.toCoord[1] - request.fromCoord[1]) * index) / (vertices - 1),
    ]),
    status: 'routed',
  };
}

test('moving a stop requests only its two adjacent legs and retains the others exactly', () => {
  const points = [
    stop('a', [15.40, 47.05], 'start'),
    stop('b', [15.41, 47.06]),
    stop('c', [15.42, 47.07]),
    stop('d', [15.43, 47.08]),
    stop('e', [15.44, 47.09], 'end'),
  ];
  const first = reconcileLegs(points, {});
  const existing = Object.fromEntries(first.requests.map((request) => [request.id, routed(request)]));

  const changed = reconcileLegs(points.map((point) =>
    point.id === 'c' ? { ...point, coord: [15.5, 47.1] } : point
  ), existing);

  assert.deepEqual(changed.requests.map((request) => request.id), [legId('b', 'c'), legId('c', 'd')]);
  assert.equal(changed.legs[legId('a', 'b')], existing[legId('a', 'b')]);
  assert.equal(changed.legs[legId('d', 'e')], existing[legId('d', 'e')]);
  assert.equal(changed.legs[legId('b', 'c')].status, 'air');
});

test('inserting a shaping point splits only its leg; IDs do not depend on geometry vertices', () => {
  const points = [
    stop('start', [15.40, 47.05], 'start'),
    stop('via', [15.41, 47.06]),
    stop('end', [15.42, 47.07], 'end'),
  ];
  const initial = reconcileLegs(points, {});
  const existing = Object.fromEntries(initial.requests.map((request) => [request.id, routed(request, 230)]));
  const shaped = insertBetween(points, 'via', 'end', shape('curve-123', [15.415, 47.065]));
  const update = reconcileLegs(shaped, existing);

  assert.deepEqual(update.requests.map((request) => request.id), [
    legId('via', 'curve-123'),
    legId('curve-123', 'end'),
  ]);
  assert.equal(update.legs[legId('start', 'via')], existing[legId('start', 'via')]);
  assert.equal(shaped[2].id, 'curve-123');
  assert.deepEqual(reconcileLegs(shaped, update.legs).requests, []);
});

test('unplaced stops do not hide the existing route; removing one only joins neighbors', () => {
  const start = stop('start', [15.4, 47.05], 'start');
  const end = stop('end', [15.5, 47.08], 'end');
  const initial = reconcileLegs([start, end], {});
  const existing = { [initial.requests[0].id]: routed(initial.requests[0]) };
  const pending = stop('pending', null);

  const withPending = reconcileLegs([start, pending, end], existing);
  assert.equal(withPending.legs[legId('start', 'end')], existing[legId('start', 'end')]);
  assert.deepEqual(withPending.requests, []);

  const placed = reconcileLegs([start, { ...pending, coord: [15.45, 47.06] }, end], withPending.legs);
  assert.deepEqual(placed.requests.map((request) => request.id), [legId('start', 'pending'), legId('pending', 'end')]);
  const removed = reconcileLegs([start, end], placed.legs);
  assert.equal(removed.legs[legId('start', 'end')].status, 'air');
  assert.deepEqual(removed.requests.map((request) => request.id), [legId('start', 'end')]);
});

test('a full optimization requests every leg without hiding the current geometry', () => {
  const points = [
    stop('start', [15.4, 47.05], 'start'),
    shape('shape', [15.41, 47.06]),
    stop('end', [15.42, 47.07], 'end'),
  ];
  const initial = reconcileLegs(points, {});
  const existing = Object.fromEntries(initial.requests.map((request) => [request.id, routed(request)]));

  const optimized = reconcileLegs(points, existing, true);
  assert.equal(optimized.requests.length, 2);
  assert.equal(optimized.legs[legId('start', 'shape')], existing[legId('start', 'shape')]);
  assert.equal(optimized.legs[legId('shape', 'end')], existing[legId('shape', 'end')]);
});

test('outdated segment IDs cannot insert a shape into another leg', () => {
  const points = [stop('a', [15.4, 47.05], 'start'), stop('b', [15.5, 47.07], 'end')];
  assert.throws(() => insertBetween(points, 'a', 'missing', shape('shape', [15.45, 47.06])), /nicht mehr aktuell/);
});

test('late replies cannot overwrite a newer edit, even when the engine ignores abort', async () => {
  const start = stop('a', [15.4, 47.05], 'start');
  const end = stop('b', [15.5, 47.07], 'end');
  const first = reconcileLegs([start, end], {});
  const unresolved = [];
  const received = [];
  const scheduler = new LegScheduler(
    (_from, _to, signal) => new Promise((resolve) => unresolved.push({ resolve, signal })),
    (_request, leg) => received.push(leg),
    () => assert.fail('Unexpected routing error'),
    () => {},
  );
  scheduler.update(first.legs, first.requests);
  await new Promise(resolve => setImmediate(resolve));

  const moved = reconcileLegs([start, { ...end, coord: [15.6, 47.08] }], first.legs);
  scheduler.update(moved.legs, moved.requests);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unresolved[0].signal.aborted, true);
  unresolved[0].resolve(routed(first.requests[0]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.length, 0);

  unresolved[1].resolve(routed(moved.requests[0]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].toCoord, [15.6, 47.08]);
});

test('routing failure leaves an explicit dashed straight-line leg', async () => {
  const result = reconcileLegs([
    stop('a', [15.4, 47.05], 'start'),
    stop('b', [15.5, 47.07], 'end'),
  ], {});
  const received = [];
  const errors = [];
  const scheduler = new LegScheduler(
    async () => { throw new Error('Kein Weg gefunden'); },
    (_request, leg) => received.push(leg),
    (_request, error) => errors.push(error),
    () => {},
  );
  scheduler.update(result.legs, result.requests);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received[0].status, 'air');
  assert.match(received[0].error, /Kein Weg gefunden/);
  assert.equal(received[0].coordinates.length, 2);
  assert.equal(errors.length, 1);
});

test('reordering stops keeps shape IDs and every unaffected leg unchanged', () => {
  const points = [
    stop('start', [15.40, 47.05], 'start'),
    stop('left', [15.41, 47.06]),
    stop('first', [15.42, 47.07]),
    shape('bend', [15.425, 47.075]),
    stop('second', [15.43, 47.08]),
    stop('right', [15.44, 47.09]),
    stop('end', [15.45, 47.1], 'end'),
  ];
  const initial = reconcileLegs(points, {});
  const routedLegs = Object.fromEntries(initial.requests.map((request) => [request.id, routed(request)]));
  const updated = [...points];
  [updated[2], updated[4]] = [updated[4], updated[2]];
  const result = reconcileLegs(updated, routedLegs);

  assert.equal(updated[3].id, 'bend');
  assert.equal(result.legs[legId('start', 'left')], routedLegs[legId('start', 'left')]);
  assert.equal(result.legs[legId('right', 'end')], routedLegs[legId('right', 'end')]);
  assert.deepEqual(result.requests.map((request) => request.id), [
    legId('left', 'second'),
    legId('second', 'bend'),
    legId('bend', 'first'),
    legId('first', 'right'),
  ]);
});

test('surface display splits within a leg but keeps point IDs instead of geometry indexes', () => {
  const coordinates = Array.from({ length: 5 }, (_, index) => [15.4 + index * .01, 47.05 + index * .01]);
  const segments = getSegments({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: {
      legId: legId('start', 'end'),
      fromId: 'start',
      toId: 'end',
      status: 'routed',
      surfaces: [
        { fromIndex: 0, toIndex: 2, surface: 'asphalt' },
        { fromIndex: 2, toIndex: 4, surface: 'unpaved' },
      ],
    },
  });

  assert.deepEqual(segments.map((segment) => segment.properties.surface), ['asphalt', 'unpaved']);
  assert.equal(segments[1].properties.fromId, 'start');
  assert.equal(segments[1].properties.toId, 'end');
  assert.deepEqual(segments[0].geometry.coordinates.at(-1), segments[1].geometry.coordinates[0]);
});

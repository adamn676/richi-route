import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { distanceMeters } from '../src/domain/route-model.ts';
import { inspectSurfaces } from '../src/domain/route-surfaces.ts';
import { parseDraft, serializeDraft } from '../src/domain/route-draft.ts';
import { useRouteStore } from '../src/stores/route.store.ts';
import { routingEngine } from '../src/services/route.service.ts';

function route(coords = [[15, 47], [15.001, 47], [15.002, 47], [15, 47]]) {
  const points = [coords[0], coords.at(-1)].map((coord, i) => ({
    id: i ? 'stop-b' : 'stop-a', type: 'stop', kind: i ? 'end' : 'start',
    coord, address: null, userInput: '', isGeocoding: false,
  }));
  const leg = {
    id: 'stop-a:stop-b', fromId: 'stop-a', toId: 'stop-b',
    fromCoord: coords[0], toCoord: coords.at(-1), coordinates: coords,
    distanceMeters: 999, ascentMeters: 0, elevations: null, status: 'routed',
    surfaces: [{ fromIndex: 0, toIndex: 1, surface: 'unpaved', surfaceTag: 'fine_gravel' }],
  };
  return { points, legs: { [leg.id]: leg }, leg };
}

test('surface totals cover the entire out-and-back geometry including unknown tails', () => {
  const { points, legs, leg } = route();
  const result = inspectSurfaces(points, legs);
  const expected = leg.coordinates.slice(1).reduce((sum, coord, i) => sum + distanceMeters(leg.coordinates[i], coord), 0);
  assert.ok(Math.abs(result.distanceMeters - expected) < 1e-8);
  assert.ok(Math.abs(result.totals.reduce((sum, t) => sum + t.meters, 0) - expected) < 1e-8);
  assert.equal(result.totals.find(t => t.key === 'fine_gravel').label, 'Feiner Schotter');
  assert.equal(result.sections.at(-1).toIndex, leg.coordinates.length - 1);
  assert.equal(result.sections.at(-1).key, 'unknown');
  assert.equal(result.sections[1].fromMeters, result.sections[0].toMeters);
});

test('recorded metal is distinct from missing surface information and legacy groups remain readable', () => {
  const { points, legs, leg } = route();
  leg.surfaces = [
    { fromIndex: 0, toIndex: 1, surface: 'unknown', surfaceTag: 'metal' },
    { fromIndex: 2, toIndex: 3, surface: 'rough' },
  ];
  const result = inspectSurfaces(points, legs);
  assert.deepEqual(result.sections.map(s => s.label), ['Metall', 'Unbekannt', 'Pflaster / Holz']);
  assert.ok(Math.abs(result.totals.find(t => t.key === 'unknown').meters - distanceMeters(leg.coordinates[1], leg.coordinates[2])) < 1e-8);
});

test('section positions follow point order rather than leg completion order', () => {
  const { points, leg } = route([[15, 47], [15.001, 47]]);
  points[1].kind = 'via';
  points.push({ ...points[1], id: 'stop-c', kind: 'end', coord: [15.002, 47] });
  const second = { ...leg, id: 'stop-b:stop-c', fromId: 'stop-b', toId: 'stop-c',
    coordinates: [[15.001, 47], [15.002, 47]], surfaces: [] };
  const result = inspectSurfaces(points, { [second.id]: second, [leg.id]: leg });
  assert.deepEqual(result.sections.map(s => s.legId), [leg.id, second.id]);
  assert.equal(result.sections[1].fromMeters, result.sections[0].toMeters);
});

test('incomplete routes have no surface totals and zero-length legs do not invent distance', () => {
  const { points, legs, leg } = route();
  assert.equal(inspectSurfaces(points, {}), null);
  leg.status = 'air';
  assert.equal(inspectSurfaces(points, legs), null);
  const zero = route([[15, 47], [15, 47]]);
  const result = inspectSurfaces(zero.points, zero.legs);
  assert.equal(result.distanceMeters, 0);
  assert.deepEqual(result.totals, []);
});

test('drafts preserve precise surface tags and reject overlapping or malformed spans', () => {
  const { points, legs } = route();
  assert.deepEqual(parseDraft(serializeDraft(points, legs)).legs, legs);
  for (const mutate of [
    spans => spans.push({ fromIndex: 0, toIndex: 2, surface: 'asphalt' }),
    spans => { spans[0].surfaceTag = {}; },
    spans => { spans[0].surfaceTag = ''; },
  ]) {
    const bad = JSON.parse(serializeDraft(points, legs));
    mutate(bad.legs['stop-a:stop-b'].surfaces);
    assert.throws(() => parseDraft(JSON.stringify(bad)));
  }
});

test('surface inspection makes no routing calls or draft edits and stale selections disappear', t => {
  setActivePinia(createPinia());
  const { points, legs, leg } = route();
  t.mock.method(routingEngine, 'routeLeg', () => { throw new Error('Unexpected reroute'); });
  t.mock.method(routingEngine, 'snap', () => { throw new Error('Unexpected snap'); });
  const store = useRouteStore();
  store.restoreDraft({ version: 1, points, legs });
  const before = serializeDraft(store.points, store.legs);
  store.inspectSurface(leg.id, 0, 1);
  assert.deepEqual(store.focusedSurface.coordinates, leg.coordinates.slice(0, 2));
  assert.equal(serializeDraft(store.points, store.legs), before);
  assert.equal(store.canUndo, false);
  assert.equal(routingEngine.routeLeg.mock.callCount(), 0);
  assert.equal(routingEngine.snap.mock.callCount(), 0);
  store._remember();
  store.inspectSurface(leg.id, 0, 1);
  store.undo();
  assert.equal(store.focusedSurface, null);
  store.inspectSurface(leg.id, 0, 1);
  store.redo();
  assert.equal(store.focusedSurface, null);
  store.inspectSurface(leg.id, 0, 1);
  store.legs = { [leg.id]: { ...leg, surfaces: [] } };
  assert.equal(store.focusedSurface, null);
});

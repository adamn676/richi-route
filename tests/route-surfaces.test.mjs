import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { distanceMeters } from '../src/domain/route-model.ts';
import { routingPolicyVersion } from '../src/config/routing-policy.ts';
import { inspectStretch, inspectSurfaces } from '../src/domain/route-surfaces.ts';
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
    distanceMeters: 999, ascentMeters: 0, elevations: null, status: 'routed', routingPolicy: routingPolicyVersion,
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
  assert.deepEqual(result.totals.map(t => t.surface), ['unpaved', 'unknown']);
  assert.equal(result.sections.at(-1).toIndex, leg.coordinates.length - 1);
  assert.equal(result.sections.at(-1).surface, 'unknown');
  assert.equal(result.sections[1].fromMeters, result.sections[0].toMeters);
});

test('what the rider corrected forms sections of its own', () => {
  const { points, legs, leg } = route();
  leg.surfaces = [
    { fromIndex: 0, toIndex: 1, surface: 'paved', surfaceTag: 'paved', osm: { surface: 'unknown' } },
    { fromIndex: 1, toIndex: 2, surface: 'paved', surfaceTag: 'asphalt' },
  ];
  assert.deepEqual(inspectSurfaces(points, legs).sections.map(s => [s.surface, s.corrected]),
    [['paved', true], ['paved', false], ['unknown', false]]);
});

test('neighbouring stretches of one group form one section, whatever their materials', () => {
  const { points, legs, leg } = route();
  leg.surfaces = [
    { fromIndex: 0, toIndex: 1, surface: 'unknown', surfaceTag: 'metal' },
    { fromIndex: 2, toIndex: 3, surface: 'rough' },
  ];
  const result = inspectSurfaces(points, legs);
  assert.deepEqual(result.sections.map(s => [s.surface, s.fromIndex, s.toIndex]), [['unknown', 0, 2], ['rough', 2, 3]]);
  const unknown = distanceMeters(leg.coordinates[0], leg.coordinates[1]) + distanceMeters(leg.coordinates[1], leg.coordinates[2]);
  assert.ok(Math.abs(result.totals.find(t => t.surface === 'unknown').meters - unknown) < 1e-8);
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
  // older drafts: their groups are translated, recorded materials regrouped
  const old = JSON.parse(serializeDraft(points, legs));
  old.legs['stop-a:stop-b'].surfaces = [
    { fromIndex: 0, toIndex: 1, surface: 'asphalt' }, { fromIndex: 1, toIndex: 2, surface: 'rough', surfaceTag: 'paving_stones' },
    { fromIndex: 2, toIndex: 3, surface: 'likelyPaved', surfaceTag: 'unknown' },
  ];
  assert.deepEqual(parseDraft(JSON.stringify(old)).legs['stop-a:stop-b'].surfaces.map(s => s.surface), ['paved', 'paved', 'likelyPaved']);
  old.legs['stop-a:stop-b'].surfaces = [{ fromIndex: 0, toIndex: 1, surface: 'likelyAsphalt' }];
  assert.deepEqual(parseDraft(JSON.stringify(old)).legs['stop-a:stop-b'].surfaces.map(s => s.surface), ['likelyPaved']);
  // what OSM says where the rider corrected the surface
  const corrected = JSON.parse(serializeDraft(points, legs));
  corrected.legs['stop-a:stop-b'].surfaces[0].osm = { surface: 'paved', surfaceTag: 'asphalt' };
  assert.deepEqual(parseDraft(JSON.stringify(corrected)).legs['stop-a:stop-b'].surfaces[0].osm, { surface: 'paved', surfaceTag: 'asphalt' });
  for (const mutate of [
    spans => spans.push({ fromIndex: 0, toIndex: 2, surface: 'asphalt' }),
    spans => { spans[0].surfaceTag = {}; },
    spans => { spans[0].surfaceTag = ''; },
    spans => { spans[0].osm = { surface: 'gravelish' }; },
    spans => { spans[0].osm = 'paved'; },
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
  store.inspectSurface(leg.id, 0, 1, 'unpaved');
  assert.deepEqual(store.focusedSurface.coordinates, leg.coordinates.slice(0, 2));
  assert.equal(store.focusedSurface.surface, 'unpaved');
  assert.equal(serializeDraft(store.points, store.legs), before);
  assert.equal(store.canUndo, false);
  assert.equal(routingEngine.routeLeg.mock.callCount(), 0);
  assert.equal(routingEngine.snap.mock.callCount(), 0);
  store._remember();
  store.inspectSurface(leg.id, 0, 1, 'unpaved');
  store.undo();
  assert.equal(store.focusedSurface, null);
  store.inspectSurface(leg.id, 0, 1, 'unpaved');
  store.redo();
  assert.equal(store.focusedSurface, null);
  store.inspectSurface(leg.id, 0, 1, 'unpaved');
  store.legs = { [leg.id]: { ...leg, surfaces: [] } };
  assert.equal(store.focusedSurface, null);
});

test('recorded tracks lie beside the roads: their sections say so and cannot be corrected', async t => {
  setActivePinia(createPinia());
  const { points, legs, leg } = route();
  leg.recorded = true;
  assert.equal(parseDraft(serializeDraft(points, legs)).legs[leg.id].recorded, true);
  const bad = JSON.parse(serializeDraft(points, legs));
  bad.legs[leg.id].recorded = 'yes';
  assert.throws(() => parseDraft(JSON.stringify(bad)));
  t.mock.method(globalThis, 'fetch', () => Promise.reject(new Error('offline')));
  const store = useRouteStore();
  store.restoreDraft({ version: 1, points, legs });
  store.setSurfaceReporting(true);
  store.pickSurfacePoint(leg.id, 0);
  store.pickSurfacePoint(leg.id, 1);
  assert.equal(store.surfaceSelection, null);
  await store.reportSurface('paved');
  assert.ok(!globalThis.fetch.mock.calls.some(call => String(call.arguments[0]).includes('surface-corrections')));
  assert.equal(store.legs[leg.id].surfaces, leg.surfaces);
});

test('a stretch to report is picked on the route: start, then end, in either order', async t => {
  setActivePinia(createPinia());
  const { points, legs, leg } = route([[15, 47], [15.001, 47], [15.002, 47], [15.003, 47], [15.004, 47]]);
  leg.surfaces = [{ fromIndex: 0, toIndex: 4, surface: 'unpaved', surfaceTag: 'gravel' }];
  const store = useRouteStore();
  store.restoreDraft({ version: 1, points, legs });
  store.inspectSurface(leg.id, 0, 4, 'unpaved');
  store.pickSurfacePoint(leg.id, 3);
  assert.equal(store.surfacePicking, null, 'only while reporting');
  store.setSurfaceReporting(true);
  assert.equal(store.surfaceFocus, null, 'reporting replaces the selected section');
  store.pickSurfacePoint(leg.id, 3);
  store.hoverSurfacePoint(1);
  assert.deepEqual(store.surfacePreview.coordinates, leg.coordinates.slice(1, 4));
  assert.equal(store.surfaceSelection, null);
  store.pickSurfacePoint(leg.id, 1);
  const selection = store.surfaceSelection;
  assert.deepEqual([selection.fromIndex, selection.toIndex, selection.surfaces, selection.corrected], [1, 3, ['unpaved'], false]);
  assert.ok(Math.abs(selection.meters - distanceMeters(leg.coordinates[1], leg.coordinates[3])) < 1e-6);
  // a tap after a finished pick starts the next stretch
  store.pickSurfacePoint(leg.id, 2);
  assert.equal(store.surfaceSelection, null);
  // reporting saves the stretch and shows it at once
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  store.pickSurfacePoint(leg.id, 0);
  store._remember();
  await store.reportSurface('paved');
  assert.deepEqual(JSON.parse(globalThis.fetch.mock.calls.at(-1).arguments[1].body),
    { points: leg.coordinates.slice(0, 3), surface: 'paved', osmSurfaces: ['gravel'] });
  assert.deepEqual(store.legs[leg.id].surfaces.map(s => [s.fromIndex, s.toIndex, s.surface]), [[0, 2, 'paved'], [2, 4, 'unpaved']]);
  assert.equal(store.surfaceSelection, null);
  // the report stays saved, so undoing an earlier edit keeps showing it
  assert.equal(store.undoStack.at(-1).legs[leg.id], store.legs[leg.id]);
  store.setSurfaceReporting(false);
  assert.equal(store.surfacePicking, null);
  assert.deepEqual(inspectStretch({ ...leg, surfaces: [{ fromIndex: 0, toIndex: 2, surface: 'paved', osm: { surface: 'unknown' } }] }, 1, 3),
    { surfaces: ['paved', 'unknown'], corrected: true });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGpxTrack } from '../src/domain/gpx-track.ts';
import { gpxSurfacePortions, inspectGpxSurfaces, matchGpxSurfaces } from '../src/domain/gpx-surfaces.ts';
import { lookupGpxSurfaces } from '../src/services/gpx-surfaces.service.ts';
import { distanceMeters } from '../src/domain/route-model.ts';

const line = (count = 101, lon = 15) => Array.from({ length: count }, (_, i) => [lon + i / 10000, 47]);
const build = (...segments) => buildGpxTrack('Surfaces', 'test.gpx', segments.map(coordinates => ({ name: '', coordinates, elevations: coordinates.map(() => null) })));
const candidate = (coordinates, surfaces = [{ fromIndex: 0, toIndex: coordinates.length - 1, surface: 'asphalt', surfaceTag: 'asphalt' }]) => ({ coordinates, surfaces, elevations: null, ascentMeters: null, distanceMeters: 0 });

test('surface portions are bounded, preserve segment breaks and skip sparse gaps', () => {
  const coords = line(50000), track = build(coords, [[16, 48]], line(4, 17));
  const portions = gpxSurfacePortions(track);
  assert.ok(portions.length > 1);
  assert.ok(portions.every(p => p.points.length <= 64));
  assert.ok(portions.every(p => p.segment !== 1));
  assert.equal(portions[0].from, 0);
  assert.equal(portions.filter(p => p.segment === 0).at(-1).to, coords.length - 1);
  const gap = build([[15, 47], [15.0001, 47], [16, 47], [16.0001, 47]]);
  assert.deepEqual(gpxSurfacePortions(gap).map(p => [p.from, p.to]), [[0, 1], [2, 3]]);
});

test('surface attribution preserves original geometry, fills unknown and does not cross a tag boundary', () => {
  const coordinates = line(5), track = build(coordinates);
  const portion = gpxSurfacePortions(track)[0];
  const midpoint = [(coordinates[2][0] + coordinates[3][0]) / 2, 47];
  const routed = [...coordinates.slice(0, 3), midpoint, ...coordinates.slice(3)];
  const spans = matchGpxSurfaces(track, portion, candidate(routed, [
    { fromIndex: 0, toIndex: 3, surface: 'asphalt', surfaceTag: 'asphalt' },
    { fromIndex: 3, toIndex: 5, surface: 'unpaved', surfaceTag: 'gravel' },
  ]));
  assert.deepEqual(spans.map(s => [s.fromIndex, s.toIndex, s.surfaceTag]), [[0, 2, 'asphalt'], [3, 4, 'gravel']]);
  const inspection = inspectGpxSurfaces(track, [spans]);
  assert.ok(inspection.totals.some(t => t.key === 'unknown'));
  assert.ok(Math.abs(inspection.totals.reduce((n, t) => n + t.meters, 0) - track.distanceMeters) < 1e-6);
  assert.deepEqual(inspection.geojson.features.flatMap((f, i) => f.geometry.coordinates.slice(i ? 1 : 0)), coordinates);
  assert.deepEqual(track.segments[0].coordinates, coordinates);
});

test('nearby roads, detours, reversed paths and missing return legs cannot supply surface tags', () => {
  const coordinates = line(), track = build(coordinates), portion = gpxSurfacePortions(track)[0];
  assert.deepEqual(matchGpxSurfaces(track, portion, candidate(coordinates.map(([x, y]) => [x, y + .0001]))), []);
  assert.deepEqual(matchGpxSurfaces(track, portion, candidate([...coordinates].reverse())), []);
  const detour = coordinates.map(([x, y], i) => [x, y + Math.sin(i / 100 * Math.PI) * .0005]);
  assert.deepEqual(matchGpxSurfaces(track, portion, candidate(detour)), []);
  const loop = [...coordinates, ...coordinates.slice(0, -1).reverse()];
  const outBack = build(loop);
  const wholeLoop = { segment: 0, from: 0, to: loop.length - 1, points: loop };
  assert.deepEqual(matchGpxSurfaces(outBack, wholeLoop, candidate(coordinates)), []);
  const complete = matchGpxSurfaces(outBack, wholeLoop, candidate(loop, [
    { fromIndex: 0, toIndex: 100, surface: 'asphalt', surfaceTag: 'asphalt' },
    { fromIndex: 100, toIndex: 200, surface: 'unpaved', surfaceTag: 'gravel' },
  ]));
  assert.deepEqual(complete.map(s => [s.fromIndex, s.toIndex, s.surfaceTag]), [[0, 100, 'asphalt'], [100, 200, 'gravel']]);
});

test('unknown tags and isolated points remain unknown; matching works across the date line', () => {
  const coords = [[179.999, 0], [179.9995, 0], [-180, 0], [-179.9995, 0]];
  const track = build(coords, [[1, 1]]), portion = gpxSurfacePortions(track)[0];
  assert.equal(matchGpxSurfaces(track, portion, candidate(coords)).length, 1);
  assert.deepEqual(matchGpxSurfaces(track, portion, candidate(coords, [])), []);
  const inspection = inspectGpxSurfaces(track, []);
  assert.equal(inspection.geojson.features.at(-1).geometry.type, 'Point');
  assert.equal(inspection.estimatedMeters, 0);
});

test('surface lookup runs sequentially and stops on failure with completed results intact', async () => {
  const track = build(line(1001));
  let active = 0, calls = 0, peak = 0;
  const progress = [];
  const result = await lookupGpxSurfaces(track, new AbortController().signal, (done, total) => progress.push([done, total]), async points => {
    calls++; peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    if (calls === 2) throw new Error('Service unavailable');
    return candidate(points);
  });
  assert.equal(peak, 1); assert.equal(calls, 2);
  assert.equal(result.error, 'Service unavailable');
  assert.ok(result.surfaces[0].length > 0);
  assert.equal(progress.at(-1)[0], 1);
  const inspection = inspectGpxSurfaces(track, result.surfaces);
  assert.ok(inspection.estimatedMeters < track.distanceMeters);
});

test('late trace responses cannot complete cancelled lookups', async () => {
  const track = build(line(1001)), controller = new AbortController();
  let calls = 0;
  await assert.rejects(lookupGpxSurfaces(track, controller.signal, () => {}, async points => {
    calls++; controller.abort(); return candidate(points);
  }), error => error.name === 'AbortError');
  assert.equal(calls, 1);
});

test('dense long-track inspection preserves every coordinate and original distance totals', () => {
  const coords = line(50000), track = build(coords);
  const surfaces = [gpxSurfacePortions(track).flatMap(portion => matchGpxSurfaces(track, portion, candidate(portion.points)))];
  const result = inspectGpxSurfaces(track, surfaces);
  assert.ok(result.estimatedMeters > track.distanceMeters * .99);
  assert.deepEqual(result.geojson.features[0].geometry.coordinates, coords);
  assert.ok(distanceMeters(coords[0], coords.at(-1)) > 0);
});

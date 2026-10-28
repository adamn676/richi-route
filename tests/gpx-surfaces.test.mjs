import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGpxTrack } from '../src/domain/gpx-track.ts';
import { gpxSurfacePortions, inspectGpxSurfaces, matchGpxSurfaces } from '../src/domain/gpx-surfaces.ts';
import { lookupGpxSurfaces } from '../src/services/gpx-surfaces.service.ts';
import { distanceMeters } from '../src/domain/route-model.ts';

const line = (count = 101, lon = 15) => Array.from({ length: count }, (_, i) => [lon + i / 10000, 47]);
const build = (...segments) => buildGpxTrack('Surfaces', 'test.gpx', segments.map(coordinates => ({ name: '', coordinates, elevations: coordinates.map(() => null) })));
const candidate = (coordinates, surfaces = [{ fromIndex: 0, toIndex: coordinates.length - 1, surface: 'paved', surfaceTag: 'asphalt' }]) => ({ coordinates, surfaces, elevations: null, ascentMeters: null, distanceMeters: 0 });

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
    { fromIndex: 0, toIndex: 3, surface: 'paved', surfaceTag: 'asphalt' },
    { fromIndex: 3, toIndex: 5, surface: 'unpaved', surfaceTag: 'gravel' },
  ]));
  assert.deepEqual(spans.map(s => [s.fromIndex, s.toIndex, s.surfaceTag]), [[0, 2, 'asphalt'], [3, 4, 'gravel']]);
  const inspection = inspectGpxSurfaces(track, [spans]);
  assert.ok(inspection.totals.some(t => t.surface === 'unknown'));
  assert.ok(Math.abs(inspection.totals.reduce((n, t) => n + t.meters, 0) - track.distanceMeters) < 1e-6);
  assert.deepEqual(inspection.geojson.features.flatMap((f, i) => f.geometry.coordinates.slice(i ? 1 : 0)), coordinates);
  assert.deepEqual(track.segments[0].coordinates, coordinates);
});

test('nearby roads, detours, reversed paths and missing return legs cannot supply surface tags', () => {
  const coordinates = line(), track = build(coordinates), portion = gpxSurfacePortions(track)[0];
  assert.equal(matchGpxSurfaces(track, portion, candidate(coordinates.map(([x, y]) => [x, y + .0001]))), null, 'A road 11 m beside');
  assert.equal(matchGpxSurfaces(track, portion, candidate([...coordinates].reverse())), null);
  const detour = coordinates.map(([x, y], i) => [x, y + Math.sin(i / 100 * Math.PI) * .0005]);
  assert.equal(matchGpxSurfaces(track, portion, candidate(detour)), null);
  const loop = [...coordinates, ...coordinates.slice(0, -1).reverse()];
  const outBack = build(loop);
  const wholeLoop = { segment: 0, from: 0, to: loop.length - 1, points: loop };
  assert.equal(matchGpxSurfaces(outBack, wholeLoop, candidate(coordinates)), null, 'The return leg is missing');
  const complete = matchGpxSurfaces(outBack, wholeLoop, candidate(loop, [
    { fromIndex: 0, toIndex: 100, surface: 'paved', surfaceTag: 'asphalt' },
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

test('surface lookup traces a few portions at a time and stops on failure with completed results intact', async () => {
  const track = build(line(3001)), portions = gpxSurfacePortions(track).length;
  let active = 0, calls = 0, peak = 0;
  const progress = [];
  const result = await lookupGpxSurfaces(track, new AbortController().signal, (done, total) => progress.push([done, total]), async points => {
    const call = ++calls; peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    if (call === 2) throw new Error('Service unavailable');
    return candidate(points);
  });
  assert.ok(peak > 1 && peak <= 4, `${peak} at once, leaving routing slots free`);
  assert.ok(calls < portions, 'No new portions start after the failure');
  assert.equal(result.error, 'Service unavailable');
  assert.ok(result.surfaces[0].length > 0);
  assert.ok(result.surfaces[0].every((span, i, spans) => !i || spans[i - 1].toIndex <= span.fromIndex), 'Spans stay in travel order');
  assert.ok(progress.at(-1)[0] > 0 && progress.at(-1)[0] < progress.at(-1)[1], 'Progress counts the metres checked');
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

test('GPS jitter and a slightly longer trace still match; tags stay with their stretch', () => {
  // The recording zigzags 4 m either side of the road; the trace wiggles 3 m and comes out about 6% longer.
  const road = line(), jittery = road.map(([x, y], i) => [x, y + (i % 2 ? 1 : -1) * .000036]);
  const track = build(jittery), portion = { segment: 0, from: 0, to: jittery.length - 1, points: jittery };
  const traced = road.map(([x, y], i) => [x, y + Math.sin(i) * .000027]);
  const spans = matchGpxSurfaces(track, portion, candidate(traced, [
    { fromIndex: 0, toIndex: 50, surface: 'paved', surfaceTag: 'asphalt' },
    { fromIndex: 50, toIndex: 100, surface: 'unpaved', surfaceTag: 'gravel' },
  ]));
  assert.deepEqual(spans.map(s => s.surfaceTag), ['asphalt', 'gravel']);
  assert.deepEqual([spans[0].fromIndex, spans[1].toIndex], [0, 100]);
  assert.ok(spans[1].fromIndex - spans[0].toIndex <= 1, 'At most the step at the change stays unknown');
});

test('a portion whose trace takes a detour is split until the halves match', async () => {
  const track = build(line(3001));
  const result = await lookupGpxSurfaces(track, new AbortController().signal, () => {}, async points => {
    // Long traces wander off through a side street; short ones stay on the road.
    const long = distanceMeters(points[0], points.at(-1)) > 600;
    return candidate(long ? points.map(([x, y], i) => [x, y + (i === 3 ? .001 : 0)]) : points);
  });
  const inspection = inspectGpxSurfaces(track, result.surfaces);
  assert.equal(result.error, '');
  assert.ok(inspection.estimatedMeters > track.distanceMeters * .99, `${inspection.estimatedMeters} of ${track.distanceMeters}`);
});

test('likely paved carries over to a track and counts as its own group', () => {
  const coordinates = line(), track = build(coordinates), portion = gpxSurfacePortions(track)[0];
  const spans = matchGpxSurfaces(track, portion, candidate(coordinates, [{ fromIndex: 0, toIndex: 100, surface: 'likelyPaved' }]));
  assert.deepEqual(spans, [{ fromIndex: 0, toIndex: 100, surface: 'likelyPaved' }]);
  const inspection = inspectGpxSurfaces(track, [spans]);
  assert.deepEqual(inspection.totals.map(t => t.surface), ['likelyPaved']);
  assert.ok(Math.abs(inspection.estimatedMeters - track.distanceMeters) < 1e-6);
});

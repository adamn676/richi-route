import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGpxTrack } from '../src/domain/gpx-track.ts';
import { gpxSurfacePortions, matchGpxSurfaces } from '../src/domain/gpx-surfaces.ts';
import { lookupGpxSurfaces } from '../src/services/gpx-surfaces.service.ts';
import { distanceMeters } from '../src/domain/route-model.ts';

const line = (count = 101, lon = 15) => Array.from({ length: count }, (_, i) => [lon + i / 10000, 47]);
const build = (...segments) => buildGpxTrack('Surfaces', segments.map(coordinates => ({ name: '', coordinates, elevations: coordinates.map(() => null) })));
// The metres given a known surface, over all segments.
const covered = (track, surfaces) => surfaces.reduce((sum, spans, s) => sum + spans.filter(span => span.surface !== 'unknown')
  .reduce((n, span) => n + track.distances[s][span.toIndex] - track.distances[s][span.fromIndex], 0), 0);
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

test('surface attribution preserves original geometry and gives a step the surface covering most of it', () => {
  const coordinates = line(5), track = build(coordinates);
  const portion = gpxSurfacePortions(track)[0];
  // The change lies three quarters into the step from vertex 2 to 3.
  const change = [coordinates[2][0] + (coordinates[3][0] - coordinates[2][0]) * .75, 47];
  const routed = [...coordinates.slice(0, 3), change, ...coordinates.slice(3)];
  const spans = matchGpxSurfaces(track, portion, candidate(routed, [
    { fromIndex: 0, toIndex: 3, surface: 'paved', surfaceTag: 'asphalt' },
    { fromIndex: 3, toIndex: 5, surface: 'unpaved', surfaceTag: 'gravel' },
  ]));
  assert.deepEqual(spans.map(s => [s.fromIndex, s.toIndex, s.surfaceTag]), [[0, 3, 'asphalt'], [3, 4, 'gravel']]);
  assert.equal(covered(track, [spans]), track.distanceMeters);
  assert.deepEqual(track.segments[0].coordinates, coordinates);
  const untagged = matchGpxSurfaces(track, portion, candidate(routed, [{ fromIndex: 3, toIndex: 5, surface: 'unpaved', surfaceTag: 'gravel' }]));
  assert.deepEqual(untagged.map(s => [s.fromIndex, s.toIndex]), [[3, 4]], 'A step mostly without a surface stays unknown');
  const concrete = matchGpxSurfaces(track, portion, candidate(routed, [
    { fromIndex: 0, toIndex: 3, surface: 'paved', surfaceTag: 'asphalt' },
    { fromIndex: 3, toIndex: 5, surface: 'paved', surfaceTag: 'concrete' },
  ]));
  assert.equal(covered(track, [concrete]), track.distanceMeters, 'A change of way on the same surface leaves no gap');
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
  assert.ok(covered(track, result.surfaces) < track.distanceMeters);
});

test('late trace responses cannot complete cancelled lookups', async () => {
  const track = build(line(1001)), controller = new AbortController();
  let calls = 0;
  await assert.rejects(lookupGpxSurfaces(track, controller.signal, () => {}, async points => {
    calls++; controller.abort(); return candidate(points);
  }), error => error.name === 'AbortError');
  assert.equal(calls, 1);
});

test('a dense long track gets its surfaces along nearly its whole length', () => {
  const coords = line(50000), track = build(coords);
  const surfaces = [gpxSurfacePortions(track).flatMap(portion => matchGpxSurfaces(track, portion, candidate(portion.points)))];
  assert.ok(covered(track, surfaces) > track.distanceMeters * .99);
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
  assert.equal(result.error, '');
  assert.ok(covered(track, result.surfaces) > track.distanceMeters * .99, `${covered(track, result.surfaces)} of ${track.distanceMeters}`);
});

test('likely paved carries over to a track', () => {
  const coordinates = line(), track = build(coordinates), portion = gpxSurfacePortions(track)[0];
  const spans = matchGpxSurfaces(track, portion, candidate(coordinates, [{ fromIndex: 0, toIndex: 100, surface: 'likelyPaved' }]));
  assert.deepEqual(spans, [{ fromIndex: 0, toIndex: 100, surface: 'likelyPaved' }]);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGpxTrack } from '../src/domain/gpx-track.ts';
import { colorGpxTrack, elevationColors, gpxEndpoints, gpxGradients, gradientBands, gradientColor, gradientRuns, inspectGpxDistance, unknownGpxColor } from '../src/domain/gpx-inspection.ts';

const segment = (coordinates, elevations) => ({ name: '', coordinates, elevations });
const build = (...segments) => buildGpxTrack('Inspection', 'test.gpx', segments);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('gradient uses distance and direction, without crossing missing heights or segments', () => {
  const coords = Array.from({ length: 11 }, (_, i) => [15 + i / 10000, 47]);
  const distances = build(segment(coords, coords.map(() => 0))).distances[0];
  for (const slope of [-.2, 0, .1]) {
    const track = build(segment(coords, distances.map(d => 100 + d * slope)));
    for (const grade of gpxGradients(track)[0]) close(grade, slope * 100);
  }
  const missing = build(segment(coords.slice(0, 5), [0, 0, null, 1000, 1000]));
  assert.deepEqual(gpxGradients(missing)[0], [null, null, null, null, null], 'Each valid run is shorter than 10 m');
  const split = build(segment(coords.slice(0, 5), [0, 0, 0, 0, 0]), segment(coords.slice(5), [1000, 1000, 1000, 1000, 1000, 1000]));
  assert.ok(gpxGradients(split).flat().every(g => g === 0));
});

test('profile colour runs follow the gradient and bridge sparse points', () => {
  const coords = Array.from({ length: 201 }, (_, i) => [15 + i / 10000, 47]);
  const distances = build(segment(coords, coords.map(() => 0))).distances[0];
  const climb = build(segment(coords, distances.map(d => 100 + Math.min(d, distances[100]) * .1)));
  const runs = gradientRuns(climb, gpxGradients(climb));
  assert.equal(runs[0].color, gradientColor(10));
  assert.equal(runs.at(-1).color, gradientColor(0));
  const sparse = build(segment([[15, 47], [15.002, 47], [15.1, 47]], [0, 20, 20]));
  assert.deepEqual(gradientRuns(sparse, gpxGradients(sparse)).map(run => run.color), [gradientColor(13), gradientColor(0)]);
  const unknown = build(segment(coords.slice(0, 3), [0, null, 0]));
  assert.deepEqual(gradientRuns(unknown, gpxGradients(unknown)), []);
});

test('stationary and isolated points have no fabricated gradient', () => {
  const track = build(segment([[15, 47], [15, 47]], [0, 100]), segment([[16, 48]], [20]));
  assert.deepEqual(gpxGradients(track), [[null, null], [null]]);
  assert.deepEqual(inspectGpxDistance(track, gpxGradients(track), 0).coordinate, [16, 48]);
});

test('inspection interpolates distance and height, clamps ends, and jumps across segment gaps', () => {
  const track = build(segment([[15, 47], [15.01, 47]], [100, 200]), segment([[16, 48], [16.02, 48]], [400, null]));
  const grades = gpxGradients(track);
  const firstLength = track.distances[0][1];
  const middle = inspectGpxDistance(track, grades, firstLength / 2);
  close(middle.coordinate[0], 15.005);
  close(middle.elevation, 150);
  assert.deepEqual(inspectGpxDistance(track, grades, -10).coordinate, [15, 47]);
  const boundary = inspectGpxDistance(track, grades, firstLength);
  assert.equal(boundary.segmentIndex, 1);
  assert.deepEqual(boundary.coordinate, [16, 48]);
  const gap = inspectGpxDistance(track, grades, (firstLength + track.distanceMeters) / 2);
  assert.equal(gap.elevation, null);
  assert.equal(gap.gradient, null);
  assert.deepEqual(inspectGpxDistance(track, grades, Infinity).coordinate, [16.02, 48]);
});

test('inspection follows the short path across the date line', () => {
  const track = build(segment([[179.9, 10], [-179.9, 10]], [10, 20]));
  const focus = inspectGpxDistance(track, gpxGradients(track), track.distanceMeters / 2);
  close(focus.coordinate[0], 180);
  close(focus.elevation, 15);
});

test('colour modes preserve vertices and segment gaps and mark unknown sections', () => {
  const track = build(
    segment([[15, 47], [15.01, 47], [15.02, 47], [15.03, 47], [15.04, 47]], [0, 100, null, 200, 300]),
    segment([[16, 48], [16.01, 48]], [500, 500]),
    segment([[17, 48]], [null]),
  );
  assert.strictEqual(colorGpxTrack(track, 'plain', []), track.geojson);
  for (const mode of ['elevation', 'gradient']) {
    const colored = colorGpxTrack(track, mode, gpxGradients(track));
    assert.ok(colored.features.some(f => f.properties.color === unknownGpxColor));
    track.geojson.features.forEach((feature, index) => {
      const parts = colored.features.filter(f => f.properties.segment === index);
      if (feature.geometry.type === 'Point') assert.deepEqual(parts[0].geometry, feature.geometry);
      else {
        const coordinates = parts.flatMap((part, i) => part.geometry.coordinates.slice(i ? 1 : 0));
        assert.deepEqual(coordinates, feature.geometry.coordinates);
      }
    });
  }
  const flat = build(segment([[15, 47], [16, 47]], [30, 30]));
  assert.equal(colorGpxTrack(flat, 'elevation', []).features[0].properties.color, elevationColors[2]);
  assert.equal(colorGpxTrack(flat, 'gradient', gpxGradients(flat)).features[0].properties.color, gradientBands[0].color);
});

test('long tracks bound colour sections without dropping geometry', () => {
  const length = 100000;
  const track = build(segment(Array.from({ length }, (_, i) => [i / 1000, 47]), Array.from({ length }, (_, i) => i % 100)));
  const colored = colorGpxTrack(track, 'elevation', []);
  assert.ok(colored.features.length <= 5001);
  assert.equal(colored.features.reduce((n, f) => n + f.geometry.coordinates.length - 1, 1), length);
});

test('endpoints distinguish open tracks, closed loops and isolated points', () => {
  const track = build(segment([[15, 47], [16, 47]], [0, 0]),
    segment([[17, 47], [18, 47], [17, 47]], [0, 0, 0]), segment([[19, 47]], [0]));
  const endpoints = gpxEndpoints(track).features;
  assert.deepEqual(endpoints.map(f => f.properties.icon), ['gpx-start', 'gpx-end', 'gpx-both', 'gpx-both']);
  assert.deepEqual(endpoints.map(f => f.geometry.coordinates), [[15, 47], [16, 47], [17, 47], [19, 47]]);
});

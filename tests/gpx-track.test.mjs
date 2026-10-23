import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGpxTrack } from '../src/domain/gpx-track.ts';
import { distanceMeters } from '../src/domain/route-model.ts';
import { decodeGpx } from '../src/domain/gpx-import.ts';

const segment = (coordinates, elevations, name = '') => ({ name, coordinates, elevations });

test('GPX decoding handles UTF-8, UTF-16 and declared Latin encodings without corrupting names', () => {
  const text = '<gpx version="1.1"><name>Größe</name></gpx>';
  assert.equal(decodeGpx(new TextEncoder().encode(text).buffer), text);
  for (const encoding of ['utf16le', 'utf16be']) {
    const bytes = Buffer.from('\ufeff' + text, 'utf16le');
    if (encoding === 'utf16be') bytes.swap16();
    assert.equal(decodeGpx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)), text);
  }
  const latin = '<?xml version="1.0" encoding="ISO-8859-1"?>' + text;
  const bytes = Buffer.from(latin, 'latin1');
  assert.equal(decodeGpx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)), latin);
  assert.throws(() => decodeGpx(new Uint8Array([0xff, 0xff]).buffer), /Zeichenkodierung/);
});

test('GPX distance and ascent exclude jumps between track segments', () => {
  const segments = [
    segment([[15, 47], [15.01, 47]], [100, 120]),
    segment([[16, 48], [16.01, 48]], [500, 505]),
  ];
  const track = buildGpxTrack('Two tracks', 'two.gpx', segments);
  assert.equal(track.distanceMeters, distanceMeters(...segments[0].coordinates) + distanceMeters(...segments[1].coordinates));
  assert.equal(track.ascentMeters, 25);
  assert.equal(track.geojson.features.length, 2);
  assert.equal(track.pointCount, 4);
  assert.equal(track.profile.path.match(/M/g).length, 2);
  assert.strictEqual(track.segments, segments);
});

test('missing elevations break the profile and prevent a misleading complete ascent', () => {
  const track = buildGpxTrack('Partial', 'partial.gpx', [
    segment([[15, 47], [15.01, 47], [15.02, 47], [15.03, 47]], [100, null, 300, 310]),
  ]);
  assert.equal(track.elevationCount, 3);
  assert.equal(track.ascentMeters, null);
  assert.equal(track.profile.path.match(/M/g).length, 2);
  assert.equal(track.profile.minimum, 100);
  assert.equal(track.profile.maximum, 310);
});

test('a single point remains visible and missing elevation stays unknown', () => {
  const track = buildGpxTrack('Point', 'point.gpx', [segment([[15, 47]], [null])]);
  assert.equal(track.geojson.features[0].geometry.type, 'Point');
  assert.equal(track.distanceMeters, 0);
  assert.equal(track.ascentMeters, null);
  assert.equal(track.profile, null);
  assert.deepEqual(track.bounds, [[15, 47], [15, 47]]);
});

test('date-line crossings use adjacent worlds for display while retaining original coordinates', () => {
  const coordinates = [[179.9, 10], [-179.9, 10], [-179.8, 10]];
  const track = buildGpxTrack('Date line', 'dateline.gpx', [segment(coordinates, [0, 1, 2])]);
  assert.deepEqual(track.segments[0].coordinates, coordinates);
  assert.ok(track.bounds[1][0] - track.bounds[0][0] < 1);
  assert.ok(track.geojson.features[0].geometry.coordinates[1][0] > 180);
  assert.ok(track.distanceMeters < 40000);
});

test('long tracks retain all data and keep the elevation SVG bounded with extrema', () => {
  const length = 100000;
  const coordinates = Array.from({ length }, (_, i) => [15 + i / 100000, 47]);
  const elevations = Array.from({ length }, (_, i) => i === 50001 ? 9999 : 300 + i % 20);
  const track = buildGpxTrack('Long', 'long.gpx', [segment(coordinates, elevations)]);
  assert.equal(track.pointCount, length);
  assert.equal(track.geojson.features[0].geometry.coordinates.length, length);
  assert.equal(track.segments[0].elevations.length, length);
  assert.equal(track.profile.maximum, 9999);
  assert.ok(track.profile.path.length < 25000);
  assert.match(track.profile.path, /,10\.0/);
});

test('polar viewport bounds and nearly antipodal distances remain finite', () => {
  const track = buildGpxTrack('Polar', 'polar.gpx', [segment([[0, 90], [180, 90]], [0, 0])]);
  assert.ok(track.bounds[0][1] <= track.bounds[1][1]);
  assert.ok(track.bounds[1][1] < 90);
  for (const from of [[0, 0], [15.123, 47.999], [10, 60], [50.123456, 77.123456]]) {
    assert.ok(Number.isFinite(distanceMeters(from, [from[0] - 180, -from[1]])));
  }
});

test('extreme elevation values cannot produce an infinite ascent or an invalid SVG', () => {
  assert.throws(() => buildGpxTrack('Overflow', 'overflow.gpx', [
    segment([[15, 47], [16, 48]], [-1e308, 1e308]),
  ]), /Höhenwerte/);
});

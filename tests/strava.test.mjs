import assert from 'node:assert/strict';
import test from 'node:test';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { familiarity, legs, sections, shareOn } from '../experiments/strava/compare.mjs';
import { fitPositions } from '../experiments/strava/fit.mjs';
import { countRide, roadLines, tileLines } from '../experiments/strava/heat.mjs';
import { roadRides, simplify } from '../experiments/strava/rides.mjs';
import { lineTile } from '../scripts/offline/tiles.mjs';

// A FIT file from records: definitions as [local, message, fields [number, size], littleEndian, developer sizes], data
// as [local, values by field], compressed-timestamp data as [local, values, true].
function fit(records) {
  const body = [], definitions = [];
  for (const record of records) {
    if (record.definition) {
      const { local, message, fields, littleEndian = true, developer = [] } = record.definition;
      definitions[local] = { fields, littleEndian, developer };
      body.push(0x40 | (developer.length ? 0x20 : 0) | local, 0, littleEndian ? 0 : 1,
        ...(littleEndian ? [message & 255, message >> 8] : [message >> 8, message & 255]), fields.length);
      for (const [number, size] of fields) body.push(number, size, size === 4 ? 0x85 : 0x02);
      if (developer.length) body.push(developer.length, ...developer.flatMap((size, i) => [i, size, 0]));
      continue;
    }
    const { local, values, compressed } = record;
    const { fields, littleEndian, developer } = definitions[local];
    body.push(compressed ? 0x80 | local << 5 | 7 : local);
    for (const [number, size] of fields) {
      const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
      if (size === 4) view.setInt32(0, values[number] ?? 0x7fffffff, littleEndian);
      else bytes.fill(values[number] ?? 0xff);
      body.push(...bytes);
    }
    for (const size of developer) body.push(...new Uint8Array(size).fill(9));
  }
  const header = new Uint8Array(14), view = new DataView(header.buffer);
  header[0] = 14;
  view.setUint32(4, body.length, true);
  header.set([...'.FIT'].map(c => c.charCodeAt(0)), 8);
  return Uint8Array.from([...header, ...body, 0, 0]);
}
const semicircles = degrees => Math.round(degrees / 180 * 2 ** 31);
const near = (actual, expected) => actual.forEach((point, i) => point.forEach((value, j) => assert.ok(Math.abs(value - expected[i][j]) < 1e-6)));

test('FIT positions come from record messages, in order, whatever the field layout', () => {
  const file = fit([
    { definition: { local: 0, message: 0, fields: [[3, 1]] } },
    { local: 0, values: { 3: 4 } },
    { definition: { local: 1, message: 20, fields: [[253, 4], [0, 4], [1, 4], [2, 2]], developer: [3] } },
    { local: 1, values: { 0: semicircles(47.07), 1: semicircles(15.44) } },
    // A record without a position (before the GPS fix) is skipped.
    { local: 1, values: {} },
    { local: 1, values: { 0: semicircles(47.08), 1: semicircles(15.45) }, compressed: true },
    // Big-endian, longitude first.
    { definition: { local: 2, message: 20, fields: [[1, 4], [0, 4]], littleEndian: false } },
    { local: 2, values: { 0: semicircles(-33.9), 1: semicircles(-151.2) } },
  ]);
  near(fitPositions(fit([])).concat(fitPositions(file)), [[15.44, 47.07], [15.45, 47.08], [-151.2, -33.9]]);
  // Two files one after another.
  assert.equal(fitPositions(Uint8Array.from([...file, ...file])).length, 6);
});

test('Damaged FIT files are refused', () => {
  assert.throws(() => fitPositions(new TextEncoder().encode('<gpx></gpx> not a fit file')), /Not a FIT file/);
  const file = fit([{ definition: { local: 0, message: 20, fields: [[0, 4], [1, 4]] } }, { local: 0, values: { 0: 1, 1: 2 } }]);
  assert.throws(() => fitPositions(file.subarray(0, file.length - 6)), /cut short/);
  const orphan = Uint8Array.from([...file.subarray(0, 14), 0, 0, 0]);
  new DataView(orphan.buffer).setUint32(4, 1, true);
  assert.throws(() => fitPositions(orphan), /before its definition/);
});

test('Road rides are the outdoor rides on a bike that is not a mountain bike, unless the name says otherwise', () => {
  const csv = 'Aktivitäts-ID,Aktivitätsdatum,Name der Aktivität,Aktivitätsart,Aktivitätsausrüstung,Dateiname\n'
    + '1,"1. Mai 2026, 08:00",Runde,Radfahrt,BMC,activities/1.fit.gz\n'
    + '2,x,"Zwift, ""Watopia""",Virtuelle Radfahrt,BMC,activities/2.fit.gz\n'
    + '3,x,Trail,Radfahrt,MTB Scott Fully 29er,activities/3.fit.gz\n'
    + '4,x,Lauf,Lauf,,activities/4.fit.gz\n'
    + '5,x,"Ohne Rad\nzweite Zeile",Radfahrt,,activities/5.fit.gz\n'
    + '6,x,Lässige MTB Runde,Radfahrt,Rennrad Alu,activities/6.fit.gz\n'
    + '7,x,Langlaufen Virgen,Radfahrt,Rennrad Alu,activities/7.fit.gz\n';
  assert.deepEqual(roadRides(csv).map(ride => [ride.id, ride.date, ride.file]), [['1', '1. Mai 2026, 08:00', 'activities/1.fit.gz']]);
});

test('Simplifying keeps the corners and drops points on the straight', () => {
  const line = [[15, 47], [15.0001, 47], [15.0002, 47.00001], [15.01, 47], [15.01, 47.01]];
  assert.deepEqual(simplify(line), [[15, 47], [15.01, 47], [15.01, 47.01]]);
});

// About 1.1 km per 0.01° of latitude.
const north = (from, to, lon = 15) => Array.from({ length: Math.round((to - from) / .001) + 1 }, (_, i) => [lon, from + i * .001]);

test('Rides are cut into legs of about the given length, turnarounds left out', () => {
  const ride = north(47, 47.1);
  // 11.1 km: legs of 3 km leave 2.1 km, a leg of its own; legs of 3.5 km leave 0.6 km, which joins the last.
  assert.deepEqual(legs(ride, 3000).map(leg => leg.length), [28, 28, 28, 20]);
  const parts = legs(ride, 3500);
  assert.deepEqual(parts.map(leg => leg.length), [33, 32, 38]);
  assert.equal(parts[0][0], ride[0]);
  assert.equal(parts.at(-1).at(-1), ride.at(-1));
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i][0], parts[i - 1].at(-1));
  // Out and back within one leg: its ends are close, so it is left out.
  const outAndBack = [...north(47, 47.02), ...north(47, 47.019).reverse()];
  assert.deepEqual(legs(outAndBack, 10_000), []);
});

test('The share of a route on the ridden track counts only what lies within the tolerance', () => {
  const track = north(47, 47.02);
  assert.equal(shareOn(track, [track]).share, 1);
  // Half the route 50 m beside the track.
  const route = [...north(47, 47.01), ...north(47.01, 47.02, 15.00066)];
  const { share, meters } = shareOn(route, [track]);
  assert.ok(Math.abs(share - .5) < .02, String(share));
  assert.ok(Math.abs(meters - 2270) < 40, String(meters));
  assert.equal(shareOn(north(47, 47.01, 15.0003), [track], 20).share, 0);
});

test('Route sections are the map\'s: snapped points, their spurs and the partial ends left out', () => {
  const road = [[15.100, 47.100], [15.110, 47.105], [15.120, 47.100], [15.130, 47.106], [15.140, 47.100], [15.150, 47.104]];
  const [, p1, p2, p3, p4] = road;
  // Through a via beside the road at p2 (reached by a spur), one in the middle of p3–p4, and one near p3, a map point.
  const route = [road[0], p1, p2, [15.12001, 47.10001], p2, p3, [15.135, 47.103], p4, road[5]];
  const vias = [[15.12003, 47.10003], [15.135, 47.10309], [15.13009, 47.106]];
  const key = ([lon, lat]) => `${Math.round(lon * 1e6) + 180_000_000},${Math.round(lat * 1e6) + 90_000_000}`;
  const section = (a, b) => `${key(a)},${key(b)}`;
  assert.deepEqual(sections(route, vias), [section(p1, p2), section(p2, p3), section(p3, p4)]);
  assert.deepEqual(sections(road.slice(0, 3)), [], 'Only partial ends');
});

test('A leg\'s familiarity counts the rides through its area', () => {
  const familiar = familiarity([north(47, 47.01), north(47, 47.01), north(47.5, 47.51)]);
  assert.equal(familiar(north(47, 47.01)), 2);
  assert.equal(familiar(north(48, 48.01)), 0);
});

const position = ([lon, lat]) => `${Math.round(lon * 1e6) + 180_000_000},${Math.round(lat * 1e6) + 90_000_000}`;
const ridden = (...points) => points.slice(1).map((point, i) => `${position(points[i])},${position(point)}`);

test('Ridden roads join into lines between junctions and where the number of rides changes', () => {
  const [a, b, c, d, e] = [[15, 47], [15.001, 47], [15.002, 47], [15.003, 47], [15.002, 47.001]];
  // a–b–c–d there and back, b–c–e once: c is a junction, b–c has three rides.
  const counted = rides => { const counts = new Map(); for (const sections of rides) countRide(counts, sections); return roadLines(counts); };
  const lines = counted([ridden(a, b, c, d), ridden(d, c, b, a), ridden(b, c, e)]);
  // Each line as its rides and its points, read from the end that sorts first.
  const shape = line => {
    const points = line.points.map(point => point.map(value => +value.toFixed(6)).join(' '));
    return `${line.rides}: ${(points[0] < points.at(-1) ? points : points.reverse()).join(', ')}`;
  };
  assert.deepEqual(lines.map(shape).sort(), ['1: 15.002 47, 15.002 47.001', '2: 15 47, 15.001 47', '2: 15.002 47, 15.003 47', '3: 15.001 47, 15.002 47']);
  // One road ridden twice the same way is one line.
  assert.deepEqual(counted([ridden(a, b, c, d), ridden(a, b, c, d)]).map(shape), ['2: 15 47, 15.001 47, 15.002 47, 15.003 47']);
});

test('Lines are cut at tile edges with a buffer and encoded as vector tiles', () => {
  // Across the edge between two zoom-14 tiles near Graz, in the middle of their row.
  const [x, y] = [8895, 5800], n = 2 ** 14;
  const edge = x / n * 360 - 180, middle = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + .5) / n))) * 180 / Math.PI;
  const tiles = tileLines([{ rides: 4, points: [[edge - .003, middle], [edge + .003, middle]] }], 14);
  assert.deepEqual([...tiles.keys()].sort(), [`${x - 1}/${y}`, `${x}/${y}`]);
  for (const [, groups] of tiles) {
    const [part] = groups.get(4);
    assert.ok(part.every(([px]) => px >= -64 && px <= 4096 + 64), String(part));
  }
  const [key, groups] = [...tiles][0];
  const layer = new VectorTile(new PbfReader(lineTile('rides', 'rides', groups))).layers.rides;
  assert.equal(layer.length, 1);
  const feature = layer.feature(0);
  assert.deepEqual([feature.type, { ...feature.properties }], [2, { rides: 4 }]);
  assert.deepEqual(feature.loadGeometry().map(line => line.map(({ x, y }) => [x, y])), groups.get(4), key);
});

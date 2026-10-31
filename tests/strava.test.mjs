import assert from 'node:assert/strict';
import test from 'node:test';
import { legs, shareOn } from '../experiments/strava/compare.mjs';
import { fitPositions } from '../experiments/strava/fit.mjs';
import { roadRides, simplify } from '../experiments/strava/rides.mjs';

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

test('Road rides are the outdoor rides on a bike that is not a mountain bike', () => {
  const csv = 'Aktivitäts-ID,Aktivitätsdatum,Name der Aktivität,Aktivitätsart,Aktivitätsausrüstung,Dateiname\n'
    + '1,"1. Mai 2026, 08:00",Runde,Radfahrt,BMC,activities/1.fit.gz\n'
    + '2,x,"Zwift, ""Watopia""",Virtuelle Radfahrt,BMC,activities/2.fit.gz\n'
    + '3,x,Trail,Radfahrt,MTB Scott Fully 29er,activities/3.fit.gz\n'
    + '4,x,Lauf,Lauf,,activities/4.fit.gz\n'
    + '5,x,"Ohne Rad\nzweite Zeile",Radfahrt,,activities/5.fit.gz\n';
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
  assert.equal(shareOn(track, track).share, 1);
  // Half the route 50 m beside the track.
  const route = [...north(47, 47.01), ...north(47.01, 47.02, 15.00066)];
  const { share, meters } = shareOn(route, track);
  assert.ok(Math.abs(share - .5) < .02, String(share));
  assert.ok(Math.abs(meters - 2270) < 40, String(meters));
  assert.equal(shareOn(north(47, 47.01, 15.0003), track, 20).share, 0);
});

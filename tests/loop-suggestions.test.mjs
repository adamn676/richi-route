import assert from 'node:assert/strict';
import test from 'node:test';
import { compassName, correctedRadius, firstRadius, loopSections, pickLoops, pointsAlong, refinedRadius, twiceShare, withoutSpurs }
  from '../src/domain/loop-suggestions.ts';
import { suggestLoops } from '../src/services/loop-suggestions.service.ts';
import { distanceMeters } from '../src/domain/route-model.ts';

const start = [15.44, 47.07];
// A loop around a circle in the given direction, about 6.2 times the radius long, climbing more towards the north.
function circle(radius, direction, { steps = 200, ascent } = {}) {
  const rad = Math.PI / 180, kx = 111320 * Math.cos(start[1] * rad), ky = 110540;
  const centre = [start[0] + Math.sin(direction * rad) * radius / kx, start[1] + Math.cos(direction * rad) * radius / ky];
  const coordinates = Array.from({ length: steps + 1 }, (_, i) => {
    const a = (direction + 180) * rad + i / steps * 2 * Math.PI;
    return i === 0 || i === steps ? start : [centre[0] + Math.sin(a) * radius / kx, centre[1] + Math.cos(a) * radius / ky];
  });
  let distance = 0;
  for (let i = 1; i < coordinates.length; i++) distance += distanceMeters(coordinates[i - 1], coordinates[i]);
  const climb = ascent ?? Math.round(radius / 10 * (1 + Math.cos(direction * rad)));
  return { coordinates, distanceMeters: distance, ascentMeters: climb, surfaces: [{ fromIndex: 0, toIndex: steps, surface: 'asphalt', surfaceTag: 'asphalt' }],
    elevations: coordinates.map((_, i) => 300 + climb / 2 * (1 - Math.cos(i / steps * 2 * Math.PI))) };
}
const candidate = (direction, leg) => ({ direction, radius: 1000, leg });

test('radius guesses home in on the distance', () => {
  assert.ok(Math.abs(firstRadius(62000) - 10000) < 1);
  assert.equal(correctedRadius({ radius: 8000, leg: { distanceMeters: 40000 } }, 50000), 10000);
  assert.equal(correctedRadius({ radius: 8000, leg: { distanceMeters: 1000 } }, 50000), 16000, 'At most double');
  // 8 km gave 40 km and 10 km gave 46 km: 3 km per km of radius, so 50 km needs about 11.3 km.
  const radius = refinedRadius({ radius: 8000, leg: { distanceMeters: 40000 } }, { radius: 10000, leg: { distanceMeters: 46000 } }, 50000);
  assert.ok(Math.abs(radius - 11333) < 1);
});

test('roads ridden both ways count against a loop', () => {
  const line = Array.from({ length: 11 }, (_, i) => [15 + i / 1000, 47]);
  assert.equal(twiceShare({ coordinates: [...line, ...line.slice(0, -1).reverse()] }), 1, 'Out and back');
  assert.equal(twiceShare(circle(5000, 0)), 0);
});

test('picks fit distance first, then climbing, and head apart', () => {
  const target = { meters: 50000, ascent: 500 };
  const loop = (km, ascent) => ({ coordinates: circle(1000, 0).coordinates, distanceMeters: km * 1000, ascentMeters: ascent, surfaces: [], elevations: null });
  const picks = pickLoops([
    candidate(0, loop(50, 500)), candidate(30, loop(50, 510)), candidate(90, loop(49, 450)),
    candidate(180, loop(70, 500)), candidate(270, loop(52, 900)), candidate(300, loop(40, 500)),
  ], target);
  assert.deepEqual(picks.map(pick => pick.direction), [0, 90, 270], '30° is too close to 0°; 70 km and 40 km miss by more than 15%');
});

test('points along a loop, compass names and sections that keep the totals', () => {
  const leg = circle(5000, 90, { steps: 400 });
  const points = pointsAlong(leg, 8);
  assert.equal(points.length, 8);
  assert.ok(points.every(point => distanceMeters(point, start) > 100));
  assert.equal(compassName(start, [15.44, 47.2]), 'Norden');
  assert.equal(compassName(start, [15.6, 47.07]), 'Osten');
  assert.equal(compassName(start, [15.3, 46.95]), 'Südwesten');
  const sections = loopSections(leg);
  assert.ok(sections.length > 2 && sections.slice(0, -1).every(section => section.distanceMeters >= 5000));
  assert.ok(Math.abs(sections.reduce((sum, section) => sum + section.distanceMeters, 0) - leg.distanceMeters) < 1e-6);
  assert.deepEqual(sections[0].coordinates[0], start);
  assert.deepEqual(sections.at(-1).coordinates.at(-1), start);
  assert.ok(sections.every(section => section.surfaces.length === 1 && section.surfaces[0].toIndex === section.coordinates.length - 1));
  assert.ok(sections.every(section => section.elevations.length === section.coordinates.length));
});

test('suggestions: three passes, three named loops, failed directions left out', async () => {
  const calls = [];
  const trace = async (from, radius, direction) => {
    calls.push({ radius, direction });
    if (direction === 150) throw new Error('no track found');
    return circle(radius, direction);
  };
  const towns = { 0: 'Nordhausen', 90: 'Ostdorf', 180: 'Südheim', 270: 'Westfeld' };
  const town = async ([lon, lat]) => {
    if (Math.abs(lon - start[0]) < .002 && Math.abs(lat - start[1]) < .002) return 'Graz';
    const bearing = (Math.atan2((lon - start[0]) * Math.cos(start[1] * Math.PI / 180), lat - start[1]) * 180 / Math.PI + 360) % 360;
    return towns[Math.round(bearing / 90) % 4 * 90];
  };
  const loops = await suggestLoops(start, { meters: 40000, ascent: 800 }, new AbortController().signal, trace, town);
  assert.equal(calls.length, 12 + 11 + 11, 'The direction without a loop is not tried again');
  assert.equal(loops.length, 3);
  assert.ok(loops.every(loop => Math.abs(loop.leg.distanceMeters - 40000) < 4000), loops.map(loop => loop.leg.distanceMeters).join());
  assert.equal(new Set(loops.map(loop => loop.place)).size, 3, 'No two loops share a name');
  assert.ok(loops.every(loop => loop.place !== 'Graz'), 'The start town names none');
  const misses = loops.map(loop => Math.abs(loop.leg.ascentMeters - 800));
  assert.equal(misses[0], Math.min(...misses), 'With distances alike, the closest climbing comes first');
});

test('a routing service that fails everywhere reports why; a cancelled search stops', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(suggestLoops(start, { meters: 40000, ascent: 300 }, signal, async () => { throw new Error('Der lokale Routing-Dienst ist nicht erreichbar.'); }, async () => undefined),
    /nicht erreichbar/);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(suggestLoops(start, { meters: 40000, ascent: 300 }, controller.signal, async () => {
    calls++; controller.abort(); throw new DOMException('Aborted', 'AbortError');
  }, async () => undefined), error => error.name === 'AbortError');
  assert.ok(calls <= 12);
});

test('dead ends leave a loop, with or without a turning circle; the road home stays', () => {
  const at = (x, y) => [15 + x / 10000, 47 + y / 10000];
  // Home H on a stub to junction J, round a square, with a straight dead end at A and one ending in a turning circle at B.
  const path = [at(0, 0), at(0, 5), at(0, 10), at(3, 10), at(6, 10), at(6, 14), at(6, 18), at(6, 14), at(6, 10), at(10, 10),
    at(10, 4), at(13, 4), at(14, 5), at(13, 6), at(13, 4), at(10, 4), at(10, 0), at(10, -2), at(5, -2), at(0, -2), at(0, 0)];
  const elevations = path.map((_, i) => 300 + i);
  // Steps 4 to 7 ride into dead end A and back out on gravel.
  const surfaces = [{ fromIndex: 0, toIndex: 4, surface: 'asphalt', surfaceTag: 'asphalt' }, { fromIndex: 4, toIndex: 8, surface: 'unpaved', surfaceTag: 'gravel' },
    { fromIndex: 8, toIndex: 20, surface: 'asphalt', surfaceTag: 'asphalt' }];
  const leg = { coordinates: path, elevations, surfaces, distanceMeters: 5000, ascentMeters: 20 };
  const clean = withoutSpurs(leg);
  assert.deepEqual(clean.coordinates, [at(0, 0), at(0, 5), at(0, 10), at(3, 10), at(6, 10), at(10, 10), at(10, 4), at(10, 0), at(10, -2), at(5, -2), at(0, -2), at(0, 0)]);
  assert.deepEqual(clean.elevations, [300, 301, 302, 303, 304, 309, 310, 316, 317, 318, 319, 320], 'Heights stay with their points');
  assert.deepEqual(clean.surfaces.map(s => [s.fromIndex, s.toIndex, s.surfaceTag]), [[0, 11, 'asphalt']], 'The gravel dead end is gone');
  assert.ok(clean.distanceMeters < leg.distanceMeters);
  assert.equal(twiceShare(clean), 0);
  const lollipop = { ...leg, coordinates: [at(0, 0), at(0, 5), at(0, 10), at(40, 10), at(40, 60), at(0, 60), at(0, 10), at(0, 5), at(0, 0)],
    elevations: null, surfaces: [] };
  assert.deepEqual(withoutSpurs(lollipop).coordinates, lollipop.coordinates, 'The road home is ridden twice, but not as a dead end');
});

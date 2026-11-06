import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestLoops } from '../src/services/loop-suggestions.service.ts';
import { distanceMeters } from '../src/domain/route-model.ts';

// The loops themselves come from the routing service (engine/planner, tested there); here they are named and taken.
const start = [15.44, 47.07];
// A loop around a circle in the given direction, about 6.2 times the radius long.
function circle(radius, direction, { steps = 200 } = {}) {
  const rad = Math.PI / 180, kx = 111320 * Math.cos(start[1] * rad), ky = 110540;
  const centre = [start[0] + Math.sin(direction * rad) * radius / kx, start[1] + Math.cos(direction * rad) * radius / ky];
  const coordinates = Array.from({ length: steps + 1 }, (_, i) => {
    const a = (direction + 180) * rad + i / steps * 2 * Math.PI;
    return i === 0 || i === steps ? start : [centre[0] + Math.sin(a) * radius / kx, centre[1] + Math.cos(a) * radius / ky];
  });
  let distance = 0;
  for (let i = 1; i < coordinates.length; i++) distance += distanceMeters(coordinates[i - 1], coordinates[i]);
  const climb = Math.round(radius / 10);
  return { coordinates, distanceMeters: distance, ascentMeters: climb, surfaces: [{ fromIndex: 0, toIndex: steps, surface: 'paved', surfaceTag: 'asphalt' }],
    elevations: coordinates.map((_, i) => 300 + climb / 2 * (1 - Math.cos(i / steps * 2 * Math.PI))) };
}
// As the routing service answers: the leg, its heading, squares, whether it rides out and back, and points to name it by.
const found = (direction, along, back = false) => ({ leg: circle(5000, direction), sections: [], heading: 'Norden', cells: [`${direction},0`], back, along });
const towns = { 0: 'Nordhausen', 90: 'Ostdorf', 180: 'Südheim', 270: 'Westfeld' };
async function town([lon, lat]) {
  if (Math.abs(lon - start[0]) < .002 && Math.abs(lat - start[1]) < .002) return 'Graz';
  const bearing = (Math.atan2((lon - start[0]) * Math.cos(start[1] * Math.PI / 180), lat - start[1]) * 180 / Math.PI + 360) % 360;
  return towns[Math.round(bearing / 90) % 4 * 90];
}
const east = km => [start[0] + km / 76, start[1]], north = km => [start[0], start[1] + km / 111];

test('loops are named after the town they pass most, never the start\'s or another\'s', async () => {
  const loops = async () => [found(0, [north(5), north(6), east(5), north(7), start]), found(90, [north(5), north(5), east(5)]),
    found(180, [start, start]), found(270, [])];
  const named = await suggestLoops(start, { meters: 40000, ascent: 800 }, new AbortController().signal, { loops, town });
  assert.deepEqual(named.map(loop => loop.place), ['Nordhausen', 'Ostdorf', undefined, undefined]);
  assert.deepEqual(named.map(loop => [loop.heading, loop.cells, loop.back]), [0, 90, 180, 270].map(d => ['Norden', [`${d},0`], false]));
  assert.equal(named[0].leg.distanceMeters, found(0, []).leg.distanceMeters);
});

test('a ride out and back is named after the town it turns in; a failed lookup names none', async () => {
  const loops = async () => [found(0, [east(20)], true)];
  const talort = async coord => distanceMeters(coord, east(20)) < 2000 ? 'Talort' : undefined;
  const [named] = await suggestLoops(start, { meters: 40000, ascent: 800 }, new AbortController().signal, { loops, town: talort });
  assert.ok(named.back && named.place === 'Talort');
  const failing = async () => { throw new Error('search down'); };
  assert.equal((await suggestLoops(start, { meters: 40000, ascent: 800 }, new AbortController().signal, { loops, town: failing }))[0].place, undefined);
});

test('the service gets the target, thirteen throws of the dice in order and the loops suggested before', async () => {
  let asked;
  const loops = async (...args) => { asked = args; return []; };
  const dice = [.5, .1, .2], earlier = [{ cells: ['1,2'], weight: .75 }], signal = new AbortController().signal;
  await suggestLoops(start, { meters: 40000, ascent: 800 }, signal, { loops, town, earlier, random: () => dice.shift() ?? 0 });
  assert.deepEqual(asked, [start, { meters: 40000, ascent: 800 }, [.5, .1, .2, ...Array(10).fill(0)], earlier, signal]);
});

test('a routing service that fails everywhere reports why', async () => {
  const loops = async () => { throw new Error('Der lokale Routing-Dienst ist nicht erreichbar.'); };
  await assert.rejects(suggestLoops(start, { meters: 40000, ascent: 300 }, new AbortController().signal, { loops, town }), /nicht erreichbar/);
});


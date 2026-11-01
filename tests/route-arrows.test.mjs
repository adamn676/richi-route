import assert from 'node:assert/strict';
import test from 'node:test';
import { arrowPoints, arrowSpacing } from '../src/utils/route-arrows.ts';

// About 1 km east, then about 1 km north, each in its own surface.
const east = [[15, 47], [15.0131, 47]], north = [[15.0131, 47], [15.0131, 47.009]];
const pieces = [{ coordinates: east, key: 'paved' }, { coordinates: north, key: 'rough' }];

test('arrows run evenly along a stretch, across its surfaces, turned along it', () => {
  const points = arrowPoints([pieces], 400);
  assert.equal(points.length, 4);
  assert.deepEqual(points.map(point => point.properties.key), ['paved', 'paved', 'rough', 'rough']);
  // Chevrons point east first, then north.
  assert.ok(Math.abs(points[0].properties.turn) < .5);
  assert.ok(Math.abs(points[3].properties.turn + 90) < .5);
});

test('a zoom step in only adds arrows between those that stay', () => {
  const coarse = arrowPoints([pieces], arrowSpacing(12, 47)), fine = arrowPoints([pieces], arrowSpacing(13, 47));
  const at = point => point.geometry.coordinates.map(value => value.toFixed(7)).join();
  const kept = new Set(fine.map(at));
  assert.ok(coarse.length > 0 && fine.length >= 2 * coarse.length);
  assert.ok(coarse.every(point => kept.has(at(point))));
});

test('arrows keep clear of the markers at the start and at marked ends', () => {
  // 995 m, a marker, 1001 m, a marker: every 490 m, those at 980 m and 1960 m would sit on the markers.
  const marked = [{ coordinates: east, key: 'paved', marked: true }, { coordinates: north, key: 'rough', marked: true }];
  const points = arrowPoints([marked], 490);
  assert.deepEqual(points.map(point => point.properties.key), ['paved', 'rough']);
});

test('a stretch shorter than the spacing gets one arrow halfway', () => {
  const points = arrowPoints([[{ coordinates: east, key: 'paved' }]], 5000);
  assert.equal(points.length, 1);
  assert.ok(Math.abs(points[0].geometry.coordinates[0] - 15.00655) < 1e-4);
});

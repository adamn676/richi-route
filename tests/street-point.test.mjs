import assert from 'node:assert/strict';
import test from 'node:test';
import { nearestOnLines } from '../src/services/street-point.service.ts';
import { distanceMeters } from '../src/domain/route-model.ts';

test('the nearest point on a street within reach, or none', () => {
  const house = [15.39296, 47.07651];
  // Georgigasse runs about 53 m north of the house; another street lies farther away.
  const georgigasse = [[15.3925, 47.07696], [15.3945, 47.07682]], far = [[15.39, 47.079], [15.396, 47.079]];
  const point = nearestOnLines(house, [far, georgigasse], 150);
  assert.ok(point[1] > house[1] && Math.abs(distanceMeters(house, point) - 50) < 5, String(point));
  assert.equal(nearestOnLines(house, [far], 150), null, 'Out of reach');
  assert.equal(nearestOnLines(house, [], 150), null);
});

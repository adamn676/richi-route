import assert from 'node:assert/strict';
import test from 'node:test';
import { nearestOnLines } from '../src/services/street-point.service.ts';
import { distanceMeters } from '../src/domain/route-model.ts';

test('the nearest point on a street within reach, or none', () => {
  const house = [15.42235, 47.06525];
  // Idlhofgasse runs about 115 m east of the house; another street lies farther away.
  const idlhofgasse = [[15.42395, 47.06504], [15.42365, 47.06639]], far = [[15.418, 47.062], [15.418, 47.068]];
  const point = nearestOnLines(house, [far, idlhofgasse], 150);
  assert.ok(point[0] > house[0] && Math.abs(distanceMeters(house, point) - 115) < 5, String(point));
  assert.equal(nearestOnLines(house, [far], 150), null, 'Out of reach');
  assert.equal(nearestOnLines(house, [], 150), null);
});

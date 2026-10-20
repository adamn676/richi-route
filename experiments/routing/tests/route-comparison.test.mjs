import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRouteGeometry } from '../route-comparison.mjs';

const point = (east, north = 0) => [15 + east / (111320 * Math.cos(47 * Math.PI / 180)), 47 + north / 111320];
const route = (id, points) => ({ id, engineId: id, normalized: { geometry: { coordinates: points.map(p => point(...p)) } } });

test('shared paths with different vertex spacing draw once without changing input', () => {
  const routes = [
    route('brouter', [[0], [100], [200]]),
    route('graphhopper', [[0], [30], [75], [200]]),
    route('ors', [[0], [200]]),
  ];
  const original = structuredClone(routes);
  const result = compareRouteGeometry(routes);
  assert.equal(result.data.features.length, 1);
  assert.deepEqual(result.shared, [['brouter', 'graphhopper', 'ors']]);
  assert.equal(result.differences.length, 0);
  assert.deepEqual(routes, original);
});

test('forks expose both branches and produce one review area', () => {
  const result = compareRouteGeometry([
    route('brouter', [[0], [50], [150], [200]]),
    route('graphhopper', [[0], [50], [60, 15], [140, 15], [150], [200]]),
    route('ors', [[0], [200]]),
  ]);
  assert.equal(result.differences.length, 1);
  assert.ok(result.data.features.some(f => f.properties.engine === 'graphhopper' && !f.properties.shared));
  assert.ok(result.data.features.some(f => f.properties.members.join(',') === 'brouter,ors'));
  const [west, south, east, north] = result.differences[0].bounds;
  assert.ok(west <= point(60, 15)[0] && east >= point(140, 15)[0]);
  assert.ok(south <= point(100)[1] && north >= point(100, 15)[1]);
});

test('rounding is shared, but nearby parallel paths and opposite directions stay distinct', () => {
  const straight = route('brouter', [[0], [200]]);
  assert.equal(compareRouteGeometry([straight, route('ors', [[0, 1], [200, 1]])]).differences.length, 0);
  for (const other of [route('ors', [[0, 6], [200, 6]]), route('ors', [[200], [0]])]) {
    const result = compareRouteGeometry([straight, other]);
    assert.equal(result.shared.length, 0);
    assert.ok(result.data.features.every(f => !f.properties.shared));
    assert.equal(result.differences.length, 1);
  }
});

test('separate forks remain separate review areas', () => {
  const result = compareRouteGeometry([
    route('brouter', [[0], [1000]]),
    route('ors', [[0], [50], [60, 20], [140, 20], [150], [750], [760, 20], [840, 20], [850], [1000]]),
  ]);
  assert.equal(result.differences.length, 2);
});

test('empty, failed, single and repeated-coordinate routes are safe', () => {
  assert.equal(compareRouteGeometry([]).data.features.length, 0);
  assert.equal(compareRouteGeometry([{ id: 'failed', engineId: 'ors', normalized: null }]).data.features.length, 0);
  const single = compareRouteGeometry([route('brouter', [[0], [0], [100]])]);
  assert.equal(single.data.features.length, 1);
  assert.equal(single.differences.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRoute, loadRouteInspection } from '../route-inspection.mjs';

const a = [15, 47, 320], b = [15.001, 47, 325], c = [15.002, 47, 330];
const feature = (coordinates, properties) => ({ features: [{ geometry: { type: 'LineString', coordinates }, properties }] });

test('surface intervals cover edges, keep exact tags, and leave uncovered edges unknown', () => {
  const data = inspectRoute('graphhopper', { paths: [{ points: { coordinates: [a, b, c, [15.003, 47]] }, details: { surface: [[0, 1, 'asphalt'], [1, 2, 'fine_gravel']] } }] });
  assert.deepEqual(data.sections.map(s => [s.fromIndex, s.toIndex, s.surface]), [[0, 1, 'asphalt'], [1, 2, 'fine_gravel'], [2, 3, 'unknown']]);
  assert.equal(data.elevations.at(-1), null);
  assert.equal(data.sections.at(-1).toM, data.distances.at(-1));
});

test('BRouter endpoint messages retain repeated loop coordinates and unknown tails', () => {
  const raw = feature([a, b, a, c], { messages: [
    ['Longitude', 'Latitude', 'Distance', 'WayTags'],
    ['15000000', '47000000', '0', ''],
    ['15000000', '47000000', '150', 'surface=sett'],
    ['15999999', '47000000', '20', 'surface=asphalt'],
  ] });
  const data = inspectRoute('brouter', raw);
  assert.deepEqual(data.sections.map(s => [s.fromIndex, s.toIndex, s.surface]), [[0, 2, 'sett'], [2, 3, 'unknown']]);
  assert.ok(data.distances[2] > data.distances[1], 'Loop return is retained on the distance axis.');
});

test('ORS numeric categories preserve paving, gravel and unknown, without inferred elevations', () => {
  const data = inspectRoute('ors', feature([a.slice(0, 2), b.slice(0, 2), c.slice(0, 2), [15.003, 47]], { extras: { surface: { values: [[0, 1, 14], [1, 2, 10], [2, 3, 999]] } } }));
  assert.deepEqual(data.sections.map(s => s.surface), ['paving_stones', 'gravel', 'unknown']);
  assert.deepEqual(data.elevations, [null, null, null, null]);
  assert.equal(data.ascentM, null);
});

test('missing tags, bad intervals and missing-height sentinel never invent certainty', () => {
  const data = inspectRoute('graphhopper', { paths: [{ points: { coordinates: [[15, 47, -32768], b, c] }, details: { surface: [[-1, 2, 'asphalt'], [0, 99, 'gravel']] } }] });
  assert.deepEqual(data.sections.map(s => s.surface), ['unknown']);
  assert.equal(data.elevations[0], null);
});

test('inspection rejects unknown runs and does not use result IDs as filesystem paths', async () => {
  await assert.rejects(loadRouteInspection('../elsewhere', '../../secret'), /Invalid run ID/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBRouterLeg, surfaceType } from '../src/domain/route-response.ts';
import { getSegments } from '../src/utils/geometry.ts';

function raw(coordinates, messages, length = '100') {
  return { features: [{ geometry: { type: 'LineString', coordinates }, properties: { 'track-length': length, messages } }] };
}
test('BRouter message endpoints delimit surfaces; missing tags and unmatched tails stay unknown', () => {
  const leg = parseBRouterLeg(raw([[15, 47], [15.001, 47], [15.002, 47], [15.003, 47]], [
    ['Longitude', 'Latitude', 'WayTags'],
    ['15001000', '47000000', 'highway=cycleway surface=asphalt'],
    ['15002000', '47000000', 'highway=cycleway'],
    ['16000000', '47000000', 'surface=asphalt'],
  ]));
  assert.deepEqual(leg.surfaces, [
    { fromIndex: 0, toIndex: 1, surface: 'asphalt', surfaceTag: 'asphalt' },
    { fromIndex: 1, toIndex: 2, surface: 'unknown' },
  ]);
  const segments = getSegments({ geometry: { coordinates: leg.coordinates }, properties: { status: 'routed', surfaces: leg.surfaces } });
  assert.equal(segments.at(-1).properties.surface, 'unknown');
  assert.deepEqual(segments.at(-1).geometry.coordinates.at(-1), [15.003, 47]);
});
test('zero-length snapped route is drawable, while malformed geometry is rejected', () => {
  const leg = parseBRouterLeg(raw([[15, 47, 300]], [], '0'));
  assert.deepEqual(leg.coordinates, [[15, 47], [15, 47]]);
  assert.deepEqual(leg.elevations, [300, 300]);
  assert.throws(() => parseBRouterLeg(raw([[15, 47]], [], '100')));
  assert.throws(() => parseBRouterLeg(raw([[190, 47], [15, 47]], [])));
  assert.throws(() => parseBRouterLeg(raw([[15, 47], [15.1, 47]], [], null)));
});
test('rough and loose surfaces are not described as smooth paving', () => {
  for (const tag of ['wood', 'sett', 'cobblestone']) assert.equal(surfaceType(tag), 'rough');
  for (const tag of ['gravel', 'compacted', 'ground']) assert.equal(surfaceType(tag), 'unpaved');
  assert.equal(surfaceType(undefined), 'unknown');
});

test('a surface span returning to the same coordinate covers the loop', () => {
  const leg = parseBRouterLeg(raw([[15, 47], [15.001, 47.001], [15, 47]], [
    ['Longitude', 'Latitude', 'Distance', 'WayTags'],
    ['15000000', '47000000', '100', 'surface=asphalt'],
  ]));
  assert.deepEqual(leg.surfaces, [{ fromIndex: 0, toIndex: 2, surface: 'asphalt', surfaceTag: 'asphalt' }]);
});

test('surface details retain different recorded materials within the same colour group', () => {
  const leg = parseBRouterLeg(raw([[15, 47], [15.001, 47], [15.002, 47], [15.003, 47], [15.004, 47]], [
    ['Longitude', 'Latitude', 'WayTags'],
    ['15001000', '47000000', 'surface=paving_stones'],
    ['15002000', '47000000', 'surface=wood'],
    ['15003000', '47000000', 'surface=metal'],
    ['15004000', '47000000', 'highway=residential'],
  ]));
  assert.deepEqual(leg.surfaces.map(s => [s.surface, s.surfaceTag]), [
    ['rough', 'paving_stones'], ['rough', 'wood'], ['unknown', 'metal'], ['unknown', undefined],
  ]);
});

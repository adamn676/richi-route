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
    ['15002000', '47000000', 'highway=path'],
    ['16000000', '47000000', 'surface=asphalt'],
  ]));
  assert.deepEqual(leg.surfaces, [
    { fromIndex: 0, toIndex: 1, surface: 'paved', surfaceTag: 'asphalt' },
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
test('materials are grouped by what they mean on a road bike', () => {
  for (const tag of ['asphalt', 'concrete', 'concrete:plates', 'paved', 'paving_stones']) assert.equal(surfaceType(tag), 'paved');
  for (const tag of ['wood', 'sett', 'cobblestone', 'unhewn_cobblestone']) assert.equal(surfaceType(tag), 'rough');
  for (const tag of ['gravel', 'fine_gravel', 'pebblestone', 'compacted', 'ground', 'grass_paver']) assert.equal(surfaceType(tag), 'unpaved');
  assert.equal(surfaceType('metal'), 'unknown');
  assert.equal(surfaceType(undefined), 'unknown');
});

test('a surface span returning to the same coordinate covers the loop', () => {
  const leg = parseBRouterLeg(raw([[15, 47], [15.001, 47.001], [15, 47]], [
    ['Longitude', 'Latitude', 'Distance', 'WayTags'],
    ['15000000', '47000000', '100', 'surface=asphalt'],
  ]));
  assert.deepEqual(leg.surfaces, [{ fromIndex: 0, toIndex: 2, surface: 'paved', surfaceTag: 'asphalt' }]);
});

test('spans keep their recorded materials within a group', () => {
  const leg = parseBRouterLeg(raw([[15, 47], [15.001, 47], [15.002, 47], [15.003, 47], [15.004, 47]], [
    ['Longitude', 'Latitude', 'WayTags'],
    ['15001000', '47000000', 'surface=paving_stones'],
    ['15002000', '47000000', 'surface=wood'],
    ['15003000', '47000000', 'surface=metal'],
    ['15004000', '47000000', 'highway=residential'],
  ]));
  assert.deepEqual(leg.surfaces.map(s => [s.surface, s.surfaceTag]), [
    ['paved', 'paving_stones'], ['rough', 'wood'], ['unknown', 'metal'], ['likelyPaved', undefined],
  ]);
});
test('without a known material, ways count by their type: roads and graded tracks are likely paved or unpaved', () => {
  const leg = parseBRouterLeg(raw([[15, 47], [15.001, 47], [15.002, 47], [15.003, 47], [15.004, 47], [15.005, 47], [15.006, 47], [15.007, 47]], [
    ['Longitude', 'Latitude', 'WayTags'],
    ['15001000', '47000000', 'highway=secondary'],
    ['15002000', '47000000', 'highway=residential'],
    ['15003000', '47000000', 'highway=track tracktype=grade1'],
    ['15004000', '47000000', 'highway=track tracktype=grade3'],
    ['15005000', '47000000', 'highway=path'],
    ['15006000', '47000000', 'highway=primary surface=gravel'],
    ['15007000', '47000000', 'highway=primary surface=unknown'],
  ]));
  assert.deepEqual(leg.surfaces, [
    { fromIndex: 0, toIndex: 3, surface: 'likelyPaved' },
    { fromIndex: 3, toIndex: 4, surface: 'unpaved' },
    { fromIndex: 4, toIndex: 5, surface: 'unknown' },
    { fromIndex: 5, toIndex: 6, surface: 'unpaved', surfaceTag: 'gravel' },
    { fromIndex: 6, toIndex: 7, surface: 'likelyPaved', surfaceTag: 'unknown' },
  ]);
});

test('a stretch the rider corrected keeps what OSM says about it', () => {
  const leg = parseBRouterLeg(raw([[15, 47], [15.001, 47], [15.002, 47], [15.003, 47]], [
    ['Longitude', 'Latitude', 'WayTags'],
    ['15001000', '47000000', 'highway=track tracktype=grade1 surface=unpaved osm:surface= osm:tracktype=grade1'],
    ['15002000', '47000000', 'highway=track tracktype=grade1 surface=paved osm:surface=gravel'],
    ['15003000', '47000000', 'highway=track tracktype=grade1 surface=paved osm:surface=gravel'],
  ]));
  assert.deepEqual(leg.surfaces, [
    { fromIndex: 0, toIndex: 1, surface: 'unpaved', surfaceTag: 'unpaved', osm: { surface: 'likelyPaved' } },
    { fromIndex: 1, toIndex: 3, surface: 'paved', surfaceTag: 'paved', osm: { surface: 'unpaved', surfaceTag: 'gravel' } },
  ]);
});

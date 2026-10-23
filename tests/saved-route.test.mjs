import assert from 'node:assert/strict';
import test from 'node:test';
import { exportRouteBackup, importRouteBackup, routeName, routeSummary } from '../src/domain/saved-route.ts';
import { parseDraft, serializeDraft } from '../src/domain/route-draft.ts';

function fixture(vertices = 3) {
  const points = [
    { id: 'stop-a', type: 'stop', kind: 'start', coord: [15.4, 47.1], address: null, userInput: '', isGeocoding: false },
    { id: 'shape-b', type: 'shape', coord: [15.5, 47.2] },
    { id: 'stop-c', type: 'stop', kind: 'end', coord: [15.4, 47.1], address: null, userInput: '', isGeocoding: false },
  ];
  const legs = {};
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1], to = points[i], id = `${from.id}:${to.id}`;
    legs[id] = {
      id, fromId: from.id, toId: to.id, fromCoord: from.coord, toCoord: to.coord,
      coordinates: Array.from({ length: vertices }, (_, n) => n === 0 ? from.coord : n === vertices - 1 ? to.coord : [15.45, 47.15]),
      elevations: Array.from({ length: vertices }, (_, n) => 300 + n % 50),
      distanceMeters: 500000, ascentMeters: 500,
      surfaces: [{ fromIndex: 0, toIndex: vertices - 1, surface: 'asphalt', surfaceTag: 'asphalt' }],
      status: 'routed', routingPolicy: 'previous-policy',
    };
  }
  return { points, legs };
}

test('editable backups preserve long loops, shaping points, exact geometry, elevations, surfaces and routing policy', () => {
  const route = fixture(31229);
  const payload = serializeDraft(route.points, route.legs);
  const backup = importRouteBackup(exportRouteBackup('  Große Runde  ', payload));
  assert.equal(backup.name, 'Große Runde');
  assert.deepEqual(parseDraft(backup.payload), parseDraft(payload));
  const summary = routeSummary(backup.name, parseDraft(backup.payload));
  assert.equal(summary.distanceMeters, 1000000);
  assert.equal(summary.pointCount, 3);
  assert.equal('legs' in summary, false, 'Library metadata does not carry full route geometry');
});

test('backup import rejects malformed data, unsupported versions and invalid route geometry', () => {
  const route = fixture();
  const good = exportRouteBackup('Route', serializeDraft(route.points, route.legs));
  for (const raw of ['{broken', 'null', '{}', '[]', '<gpx/>']) assert.throws(() => importRouteBackup(raw));
  for (const mutate of [
    d => { d.version = 2; },
    d => { d.format = 'other'; },
    d => { d.name = ''; },
    d => { d.name = 'x'.repeat(121); },
    d => { d.draft.points[0].coord = [200, 47]; },
    d => { d.draft.legs['stop-a:shape-b'].elevations = [1]; },
    d => { d.draft.legs['stop-a:shape-b'].surfaces[0].toIndex = 999; },
  ]) {
    const data = JSON.parse(good);
    mutate(data);
    assert.throws(() => importRouteBackup(JSON.stringify(data)));
  }
});

test('names are trimmed, bounded and handled as plain text', () => {
  assert.equal(routeName(' <img src=x onerror=alert(1)> '), '<img src=x onerror=alert(1)>');
  for (const name of [undefined, null, 123, '', '   ', 'x'.repeat(121)]) assert.throws(() => routeName(name));
});

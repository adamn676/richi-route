import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyReport, compileCorrections, formatCorrections, osmSurfaces, recordReport, validateCorrections } from '../src/domain/surface-corrections.ts';
import { surfaceCorrections } from '../scripts/surface-corrections.ts';

const empty = { schemaVersion: 1, corrections: [] };
const stretch = [[15.4499, 47.079854], [15.44984, 47.079917], [15.449871, 47.079932], [15.449999, 47.079999]];

test('the corrections in git are valid and kept one per line', async () => {
  const text = await readFile(new URL('../config/surface-corrections.json', import.meta.url), 'utf8');
  assert.equal(formatCorrections(validateCorrections(JSON.parse(text))), text);
  const data = recordReport(empty, { points: stretch, surface: 'paved', osmSurfaces: ['', 'gravel', ''] }, '2026-10-28');
  assert.deepEqual(data.corrections, [{ surface: 'paved', reportedOn: '2026-10-28', osmSurfaces: ['', 'gravel'], points: stretch }]);
  const formatted = formatCorrections(data);
  assert.equal(formatted.trimEnd().split('\n').length, 6);
  assert.deepEqual(JSON.parse(formatted), data);
});

test('a report replaces what it overlaps; the overlapped corrections keep their other parts', () => {
  const first = recordReport(empty, { points: stretch, surface: 'paved', osmSurfaces: [''] }, '2026-10-01');
  // reversed, as the way back reports it
  const middle = [stretch[2], stretch[1]];
  const second = recordReport(first, { points: middle, surface: 'unpaved', osmSurfaces: ['paved'] }, '2026-10-28');
  assert.deepEqual(second.corrections.map(c => [c.surface, c.points]), [
    ['paved', stretch.slice(0, 2)], ['paved', stretch.slice(2)], ['unpaved', middle],
  ]);
  const removed = recordReport(second, { points: stretch.slice(0, 3), surface: null, osmSurfaces: ['', 'paved'] }, '2026-10-28');
  assert.deepEqual(removed.corrections.map(c => [c.surface, c.points]), [['paved', stretch.slice(2)]]);
});

test('malformed reports and corrections are refused', () => {
  for (const report of [
    { points: stretch, surface: 'gravel', osmSurfaces: [''] },
    { points: stretch, surface: 'paved', osmSurfaces: [] },
    { points: stretch, surface: 'paved', osmSurfaces: ['a\tb'] },
    { points: stretch, surface: 'paved', osmSurfaces: ['a,b'] },
    { points: stretch.slice(0, 1), surface: 'paved', osmSurfaces: [''] },
    { points: [stretch[0], stretch[0]], surface: 'paved', osmSurfaces: [''] },
    { points: [[15.1234567, 47], stretch[0]], surface: 'paved', osmSurfaces: [''] },
    { points: [[200, 47], stretch[0]], surface: 'paved', osmSurfaces: [''] },
    { points: stretch, surface: 'paved', osmSurfaces: [''], note: 'x' },
    null,
  ]) assert.throws(() => recordReport(empty, report, '2026-10-28'), /Surface corrections:/, JSON.stringify(report));
  for (const data of [{ schemaVersion: 2, corrections: [] }, { ...empty, extra: 1 },
    { schemaVersion: 1, corrections: [{ surface: 'paved', reportedOn: 'today', osmSurfaces: [''], points: stretch }] }]) {
    assert.throws(() => validateCorrections(data), /Surface corrections:/);
  }
});

test('the engine gets the tag edits and micro-degree points of each correction', async () => {
  const data = recordReport(empty, { points: stretch.slice(0, 2), surface: 'rough', osmSurfaces: ['', 'asphalt'] }, '2026-10-28');
  assert.equal(compileCorrections(data), 'richiroute-surfaces\t1\n,asphalt\tsurface * cobblestone;tracktype grade2|grade3|grade4|grade5 grade1;'
    + 'smoothness * -\t195449900,137079854 195449840,137079917\n');
  // the edited tags and values exist in the routing data
  const lookups = await readFile(new URL('../experiments/routing/.local/local-routing-rules/profiles/lookups.dat', import.meta.url), 'utf8').catch(() => null);
  if (!lookups) return;
  const way = lookups.split('---context:node')[0].split('\n').map(line => line.trim().split(/\s+/));
  const values = key => way.filter(([field]) => field.split(';')[0] === key).map(([, value]) => value);
  const all = ['paved', 'unpaved', 'rough'].flatMap(surface => compileCorrections(recordReport(empty, { points: stretch, surface, osmSurfaces: [''] }, '2026-10-28'))
    .split('\n')[1].split('\t')[1].split(';').map(edit => edit.split(' ')));
  for (const [key, only, value] of all) {
    assert.ok(values(key).length, key);
    for (const v of [...(only === '*' ? [] : only.split('|')), ...(value === '-' ? [] : [value])]) assert.ok(values(key).includes(v), `${key}=${v}`);
  }
});

test('the route shows a report at once, on every leg that passes the stretch', () => {
  const coordinates = [[15.449, 47.0797], ...stretch];
  const leg = (id, coords, surfaces) => ({ id, coordinates: coords, surfaces });
  const legs = {
    out: leg('out', coordinates, [{ fromIndex: 0, toIndex: 2, surface: 'paved', surfaceTag: 'asphalt' }]),
    back: leg('back', [...coordinates].reverse(), []),
    elsewhere: leg('elsewhere', [[16, 47], [16.001, 47]], []),
  };
  assert.deepEqual(osmSurfaces(legs.out, 0, 4), ['', 'asphalt']);
  const points = stretch.slice(0, 3);
  const reported = applyReport(legs, { points, surface: 'unpaved' });
  const unpaved = { surface: 'unpaved', surfaceTag: 'unpaved' };
  assert.deepEqual(reported.out.surfaces, [
    { fromIndex: 0, toIndex: 1, surface: 'paved', surfaceTag: 'asphalt' },
    { fromIndex: 1, toIndex: 2, ...unpaved, osm: { surface: 'paved', surfaceTag: 'asphalt' } },
    { fromIndex: 2, toIndex: 3, ...unpaved, osm: { surface: 'unknown' } },
  ]);
  assert.deepEqual(reported.back.surfaces, [{ fromIndex: 1, toIndex: 3, ...unpaved, osm: { surface: 'unknown' } }]);
  assert.equal(reported.elsewhere, legs.elsewhere);
  assert.deepEqual(osmSurfaces(reported.out, 1, 3), ['', 'asphalt']);
  // where OSM already has the reported surface, the engine changes nothing, and neither does the route
  const tagged = { ...legs.out, surfaces: [{ fromIndex: 0, toIndex: 4, surface: 'unpaved', surfaceTag: 'unpaved' }] };
  assert.equal(applyReport({ tagged }, { points, surface: 'unpaved' }).tagged, tagged);
  const removed = applyReport(reported, { points, surface: null });
  assert.deepEqual(removed.out.surfaces, [
    { fromIndex: 0, toIndex: 2, surface: 'paved', surfaceTag: 'asphalt' }, { fromIndex: 2, toIndex: 3, surface: 'unknown' },
  ]);
});

test('the planner server saves reports to git and the engine file, and refuses requests other sites could send', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'surface-corrections-'));
  t.after(() => rm(directory, { recursive: true }));
  const config = path.join(directory, 'surface-corrections.json'), engineFile = path.join(directory, 'engine/surfaces.tsv');
  await writeFile(config, formatCorrections(empty));
  let handler;
  surfaceCorrections(config, engineFile).configureServer({ middlewares: { use: (_path, h) => { handler = h; } } });
  const send = (method, contentType, body, host = '127.0.0.1:5173') => new Promise(resolve => {
    const request = Object.assign(new EventEmitter(), { method, headers: { 'content-type': contentType, host }, setEncoding() {}, destroy() {} });
    const response = { statusCode: 200, end: text => resolve([response.statusCode, text]) };
    handler(request, response);
    request.emit('data', JSON.stringify(body));
    request.emit('end');
  });
  const report = { points: stretch, surface: 'unpaved', osmSurfaces: [''] };
  assert.deepEqual(await send('POST', 'text/plain', report), [405, '']);
  assert.deepEqual(await send('GET', 'application/json', report), [405, '']);
  // a page whose name points at this computer
  assert.deepEqual(await send('POST', 'application/json', report, 'rebound.example:5173'), [403, '']);
  assert.equal((await send('POST', 'application/json', { ...report, surface: 'gravel' }))[0], 400);
  assert.equal((await send('POST', 'application/json', report))[0], 204);
  const saved = validateCorrections(JSON.parse(await readFile(config, 'utf8')));
  assert.equal(saved.corrections[0].surface, 'unpaved');
  assert.equal(await readFile(engineFile, 'utf8'), compileCorrections(saved));
});

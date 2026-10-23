import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { engines, normalize, requestFor, route, variants } from '../engines.mjs';
import { loadScenarios, readRun, root, runBenchmark, saveReview, validateReview } from '../run.mjs';

const points = [{ role: 'stop', coord: [15.4, 47.1] }, { role: 'shape', coord: [15.5, 47.2] }, { role: 'stop', coord: [15.4, 47.1] }];
const geometry = { type: 'LineString', coordinates: [[15, 47], [15, 47.001], [15, 47.002]] };

test('12 draft scenarios stay separated into tuning and evaluation', async () => {
  const suite = await loadScenarios();
  assert.equal(suite.status, 'draft-needs-richard-review');
  assert.equal(suite.scenarios.length, 12);
  assert.equal(new Set(suite.scenarios.map((item) => item.id)).size, 12);
  for (const split of ['tuning', 'evaluation']) assert.equal(suite.scenarios.filter((item) => item.split === split).length, 6);
  for (const scenario of suite.scenarios) {
    if (scenario.expectedRoads.length) assert.ok(scenario.expectedRoadsSource?.trim(), 'Expected roads need an explicit review source.');
    if (scenario.split === 'evaluation') assert.deepEqual(scenario.expectedRoads, []);
    for (const variant of variants(scenario)) for (const engine of Object.keys(engines)) assert.doesNotThrow(() => requestFor(engine, variant.points));
  }
});

test('variants keep point order, repeated endpoints and unchanged distant shaping points', () => {
  const source = { points, edit: { pointIndex: 1, coord: [15.6, 47.2] } };
  const [automatic, selected, edited] = variants(source);
  assert.deepEqual(automatic.points, [points[0], points[2]]);
  assert.deepEqual(selected.points, points);
  assert.deepEqual(edited.points[1].coord, [15.6, 47.2]);
  assert.deepEqual(edited.points[0], selected.points[0]);
  assert.deepEqual(edited.points[2], selected.points[2]);
  assert.deepEqual(source.points[1].coord, [15.5, 47.2]);
  assert.throws(() => variants({ points, edit: { pointIndex: 0, coord: [15.6, 47.2] } }), /shaping/);
});

test('engine requests use the right coordinate order and retain duplicate positions', () => {
  const gh = new URL(requestFor('graphhopper', points).url);
  const br = new URL(requestFor('brouter', points).url);
  assert.deepEqual(gh.searchParams.getAll('point'), ['47.1,15.4', '47.2,15.5', '47.1,15.4']);
  assert.equal(br.searchParams.get('lonlats'), '15.4,47.1|15.5,47.2|15.4,47.1');
  assert.deepEqual(gh.searchParams.getAll('details'), ['surface', 'smoothness', 'road_class']);
});

test('unknown engines and malformed coordinates are rejected before any fetch', () => {
  assert.throws(() => requestFor('hosted-ors', points), /Hosted routing is disabled/);
  assert.throws(() => requestFor('constructor', points), /Hosted routing is disabled/);
  assert.throws(() => requestFor('graphhopper', [{ coord: [999, 47] }, points[0]]), /valid/);
  assert.throws(() => requestFor('brouter', [{ coord: [15, NaN] }, points[0]]), /valid/);
  for (const engine of Object.keys(engines)) assert.equal(new URL(requestFor(engine, points).url).hostname, '127.0.0.1');
});

test('local ORS sends ordered coordinates in a JSON POST without a hosted key or routing overrides', async () => {
  const request = requestFor('ors', points, 'traffic-v3');
  assert.equal(request.url, 'http://127.0.0.1:8082/ors/v2/directions/cycling-road/geojson');
  assert.equal(request.method, 'POST');
  assert.deepEqual(request.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(request.body), { coordinates: points.map(p => p.coord), instructions: false, elevation: false, extra_info: ['surface'] });
  let calls = 0;
  const output = await route('ors', points, async (url, options) => {
    calls++;
    assert.equal(url, request.url);
    assert.equal(options.method, 'POST');
    assert.equal(options.body, request.body);
    assert.deepEqual(options.headers, request.headers);
    assert.equal(options.redirect, 'error');
    return new Response('{"error":{"message":"Point not found"}}', { status: 404 });
  });
  assert.equal(calls, 1);
  assert.equal(output.status, 'error');
  assert.equal(output.httpStatus, 404);
  assert.match(output.rawText, /Point not found/);
});

test('ORS normalizes seconds and metres; zero codes and missing intervals stay unknown', () => {
  const output = normalize('ors', { features: [{ geometry, properties: { summary: { distance: 222, duration: 120 }, extras: { surface: { values: [[0, 1, 3], [1, 2, 0]] } } } }] });
  assert.equal(output.distanceM, 222);
  assert.equal(output.durationS, 120);
  assert.equal(output.ascentM, null);
  assert.ok(Math.abs(output.unknownSurfacePercent - 50) < 0.01);
  const absent = normalize('ors', { features: [{ geometry, properties: {} }] });
  assert.equal(absent.unknownSurfacePercent, 100);
  assert.equal(absent.distanceM, null);
  assert.throws(() => normalize('ors', { features: [] }), /LineString/);
});

test('ORS opt-in rejects ambiguous values before starting a run', async () => {
  for (const includeOrs of ['true', 'false', 1, null]) await assert.rejects(runBenchmark({ includeOrs }), /must be a boolean/);
});

test('experimental settings change only the BRouter profile and reject unknown presets', () => {
  for (const settings of ['cyclepath-v1', 'network-v2', 'traffic-v3', 'surface-v4']) {
    assert.deepEqual(requestFor('graphhopper', points, settings), requestFor('graphhopper', points));
    assert.deepEqual(requestFor('ors', points, settings), requestFor('ors', points));
    assert.equal(new URL(requestFor('brouter', points, settings).url).searchParams.get('profile'), `richi-${settings}`);
  }
  assert.equal(new URL(requestFor('brouter', points).url).searchParams.get('profile'), 'richi-road');
  assert.throws(() => requestFor('brouter', points, 'unknown'), /Unknown engine settings/);
  assert.throws(() => requestFor('brouter', points, '__proto__'), /Unknown engine settings/);
});

test('candidate settings cannot run held-out evaluation cases before settings are frozen', async () => {
  for (const settings of ['cyclepath-v1', 'network-v2', 'traffic-v3', 'surface-v4', 'thal-local-v1', 'weidweg-local-v1', 'weidweg-search-v1', 'weidweg-search-v2', 'weidweg-search-v3', 'local-rules-v1']) {
    await assert.rejects(runBenchmark({ split: 'evaluation', settings }), /limited to tuning/);
    await assert.rejects(runBenchmark({ split: 'all', settings }), /limited to tuning/);
    await assert.rejects(runBenchmark({ caseId: '07-south-quiet', settings }), /limited to tuning/);
  }
});

test('Thal preview retains ordered points and surface-v4, and applies its soft preference only to BRouter', () => {
  const ordinary = new URL(requestFor('brouter', points, 'surface-v4').url);
  const preview = new URL(requestFor('brouter', points, 'thal-local-v1').url);
  assert.equal(preview.searchParams.get('profile'), ordinary.searchParams.get('profile'));
  assert.equal(preview.searchParams.get('lonlats'), ordinary.searchParams.get('lonlats'));
  assert.ok(Number(preview.searchParams.get('nogos').split(',')[3]) > 0, 'A finite positive weight keeps the path usable');
  assert.equal(ordinary.searchParams.has('nogos'), false);
  for (const engine of ['graphhopper', 'ors']) {
    assert.deepEqual(requestFor(engine, points, 'thal-local-v1'), requestFor(engine, points, 'surface-v4'));
  }
});

test('GraphHopper interval end is exclusive and uncovered surface remains unknown', () => {
  const output = normalize('graphhopper', { paths: [{ points: geometry, distance: 222, time: 120000, details: { surface: [[0, 1, 'asphalt']] } }] });
  assert.ok(Math.abs(output.unknownSurfacePercent - 50) < 0.01);
  assert.equal(output.durationS, 120);
  assert.equal(normalize('graphhopper', { paths: [{ points: geometry }] }).durationS, null);
  assert.equal(normalize('graphhopper', { paths: [{ points: geometry }] }).unknownSurfacePercent, 100);
});

test('BRouter uses message distances, preserves missing metrics and detects absent tags', () => {
  const output = normalize('brouter', { features: [{ geometry, properties: { 'track-length': '222', 'total-time': '120', messages: [['Distance', 'WayTags'], ['100', 'highway=residential surface=asphalt'], ['20', 'highway=path']] } }] });
  assert.equal(output.distanceM, 222);
  assert.equal(output.durationS, 120);
  assert.equal(output.ascentM, null);
  assert.equal(output.unknownSurfaceM, 20);
  assert.ok(Math.abs(output.unknownSurfacePercent - 100 / 6) < 0.001);
  assert.equal(normalize('brouter', { features: [{ geometry, properties: {} }] }).unknownSurfacePercent, 100);
});

test('empty or malformed engine geometries are failures, not routes', () => {
  assert.throws(() => normalize('graphhopper', { paths: [] }), /LineString/);
  assert.throws(() => normalize('brouter', { features: [{ geometry: { type: 'Point' } }] }), /LineString/);
});

test('failed responses retain raw evidence and use no redirects or retries', async () => {
  let calls = 0;
  const output = await route('graphhopper', points, async (_, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    return new Response('No routable point', { status: 400 });
  });
  assert.equal(calls, 1);
  assert.equal(output.status, 'error');
  assert.equal(output.rawText, 'No routable point');
  assert.equal(output.httpStatus, 400);
  assert.equal(output.normalized, null);
  const invalid = await route('brouter', points, async () => new Response('not JSON'));
  assert.equal(invalid.status, 'error');
  assert.equal(invalid.rawText, 'not JSON');
});

test('review requires inspected locations and does not turn unknown metrics into zero', () => {
  const review = { reviewer: 'Richard', locationsReviewed: true, unwantedM: null, corrections: null, requiredRoadsKept: null, distantRoadsKept: null, notes: '' };
  assert.equal(validateReview(review).unwantedM, null);
  assert.throws(() => validateReview({ ...review, locationsReviewed: false }), /checked/);
  assert.throws(() => validateReview({ ...review, unwantedM: -1 }), /Invalid/);
  assert.throws(() => validateReview({ ...review, corrections: 1.5 }), /Invalid/);
  assert.throws(() => validateReview({ ...review, corrections: '0' }), /Invalid/);
});

test('saved run IDs cannot escape the private runs folder', async () => {
  await assert.rejects(readRun('../../.env'), /Invalid run ID/);
  await assert.rejects(readRun('C:\\secrets'), /Invalid run ID/);
});

test('reviews persist independently without overwriting earlier judgments', async () => {
  const runsRoot = path.join(root, '.local/runs');
  await mkdir(runsRoot, { recursive: true });
  const directory = await mkdtemp(path.join(runsRoot, 'test-review-'));
  assert.equal(path.dirname(directory), runsRoot);
  const runId = path.basename(directory);
  await writeFile(path.join(directory, 'run.json'), JSON.stringify({ results: [{ id: 'route', status: 'ok' }] }));
  const review = { reviewer: 'Automated fixture', locationsReviewed: true, unwantedM: null, corrections: null, requiredRoadsKept: null, distantRoadsKept: null, notes: 'Test fixture, not a rider judgment.' };
  try {
    await saveReview(runId, 'route', review);
    await saveReview(runId, 'route', { ...review, corrections: 2 });
    const files = await readdir(path.join(directory, 'reviews'));
    assert.equal(files.length, 2);
    const records = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(directory, 'reviews', file), 'utf8'))));
    assert.deepEqual(new Set(records.map((record) => record.corrections)), new Set([null, 2]));
    await assert.rejects(saveReview(runId, 'missing-route', review), /successful route/);
  } finally {
    for (const file of await readdir(path.join(directory, 'reviews'))) await unlink(path.join(directory, 'reviews', file));
    await rmdir(path.join(directory, 'reviews'));
    await unlink(path.join(directory, 'run.json'));
    await rmdir(directory);
  }
});

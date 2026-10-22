import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { distanceM, normalize, requestFor } from './engines.mjs';
import { assessReviewedRoute, geometryHash } from './reviewed-routes.mjs';
import { provenance } from './run.mjs';

const suite = JSON.parse(await readFile(new URL('./fixtures/reviewed-routes.json', import.meta.url), 'utf8'));
const target = suite.routes.find(r => r.id === '11-western-loop-selected');
// The diagnostic landmarks below refer to this accepted geometry, not new destinations.
assert.equal(target.geometrySha256, '60f14a9c5f5074ebd8ed2c39f1a4b1d73e561de2a1c732cc50cce53fb773d063');
for (const r of suite.routes) assert.equal(geometryHash(r.coordinates), r.geometrySha256);
const shape = index => ({ role: 'shape', coord: target.coordinates[index] });
const quiet = [45, 96].map(shape);
const rampIndices = [[200, 201], [202, 203]];
const baselineName = 'richi-surface-v4';
const candidateName = 'richi-weidweg-v1';
const profiles = new URL('./.local/brouter/profiles2/', import.meta.url);
const baseline = await readFile(new URL(baselineName + '.brf', profiles), 'utf8');
const candidate = await readFile(new URL(candidateName + '.brf', profiles), 'utf8');

const createdAt = new Date().toISOString();
const directory = new URL(`./.local/western-gap/${createdAt.replaceAll(/[:.]/g, '-')}/`, import.meta.url);
await mkdir(directory, { recursive: true });
const report = {
  createdAt, fixtureSha256: geometryHash(suite), provenance: await provenance('weidweg-local-v1', false),
  baseline: { name: baselineName, content: baseline, sha256: createHash('sha256').update(baseline).digest('hex') },
  candidate: { name: candidateName, content: candidate, sha256: createHash('sha256').update(candidate).digest('hex') },
  limitations: [
    'Diagnostic only. The editor and comparison presets continue to use their existing profiles.',
    'The active profile requires the scoped Weidweg engine patch. The baseline excludes these stairs.',
    'Explicit corridor points diagnose missing preferences; they do not count as automatic routing success.',
    'Lendkai has bicycle=use_sidepath in the local data. A shaped match does not establish that riding the road is permitted.',
    'Passing the protected examples does not establish suitability for other routes or ramped stairs.',
  ],
  results: [], regressions: 0, errors: 0,
};

async function probe(id, points, profile, reference, protect = false) {
  const request = requestFor('brouter', points, 'weidweg-local-v1');
  const url = new URL(request.url);
  url.searchParams.set('profile', profile);
  request.url = url.href;
  const result = { id, request, points, protect };
  report.results.push(result);
  try {
    const response = await fetch(request.url, { redirect: 'error', signal: AbortSignal.timeout(70000) });
    const rawText = await response.text();
    await writeFile(new URL(id + '.response.json', directory), rawText);
    assert.ok(response.ok, `HTTP ${response.status}: ${rawText.slice(0, 500)}`);
    const raw = JSON.parse(rawText);
    const line = normalize('brouter', raw).geometry.coordinates;
    result.assessment = assessReviewedRoute(reference, line);
    result.status = protect ? result.assessment.matches ? 'preserved' : 'regression' : result.assessment.matches ? 'matched' : 'different';
    result.rampsVisited = rampIndices.map(indices => indices.every(i => line.some(c => distanceM(c, target.coordinates[i]) < 1)));
    const [header, ...messages] = raw.features.find(f => f.geometry?.type === 'LineString').properties.messages;
    result.sidepathInstructions = messages.filter(m => /(?:^|\s)bicycle=use_sidepath(?:\s|$)/.test(m[header.indexOf('WayTags')])).map(m => ({
      end: [Number(m[header.indexOf('Longitude')]) / 1e6, Number(m[header.indexOf('Latitude')]) / 1e6],
      distanceM: Number(m[header.indexOf('Distance')]), costPerKm: Number(m[header.indexOf('CostPerKm')]),
      tags: m[header.indexOf('WayTags')],
    }));
    result.steps = messages.filter(m => /(?:^|\s)highway=steps(?:\s|$)/.test(m[header.indexOf('WayTags')])).map(m => ({
      end: [Number(m[header.indexOf('Longitude')]) / 1e6, Number(m[header.indexOf('Latitude')]) / 1e6],
      distanceM: Number(m[header.indexOf('Distance')]), tags: m[header.indexOf('WayTags')],
    }));
    if (result.status === 'regression') report.regressions++;
    console.log(`${id}: ${result.status}; ${result.assessment.geometry.lengthDifferenceM.toFixed(1)} m length difference; ${result.steps.length} step sections`);
  } catch (error) {
    result.status = 'error';
    result.error = error.message;
    report.errors++;
    console.log(`${id}: error; ${error.message}`);
  }
  await writeFile(new URL('report.json', directory), JSON.stringify(report, null, 2) + '\n');
}

for (const [name, points] of [
  ['main', target.points],
  ['shaped-quiet', [target.points[0], ...quiet, ...target.points.slice(1)]],
]) {
  await probe(name + '-baseline', points, baselineName, target);
  await probe(name + '-active', points, candidateName, target);
}
for (const [id, from, to, via] of [
  ['lendkai-start', 0, 45],
  ['lendkai-sidepath-tag', 4, 5],
  ['quiet-corridor', 45, 96],
  ['augasse-connection', 96, 132, 119],
  ['ramped-passage', 195, 209],
  ['western-branch', 238, 250, 244],
]) {
  const points = [shape(from), shape(to)];
  const reference = { coordinates: target.coordinates.slice(from, to + 1), points };
  await probe(id + '-active', points, candidateName, reference);
  if (via !== undefined) await probe(id + '-shaped', [points[0], shape(via), points[1]], candidateName, reference);
  if (id === 'ramped-passage') await probe(id + '-baseline', points, baselineName, reference);
}
for (const reference of suite.routes.filter(r => r.expectation === 'preserve')) {
  await probe(reference.id, reference.points, candidateName, reference, true);
}
console.log(`Saved ${fileURLToPath(new URL('report.json', directory))}`);
console.log(`${report.regressions} protected-route regressions; ${report.errors} errors. No default profile changed.`);
if (report.regressions || report.errors) process.exitCode = 1;

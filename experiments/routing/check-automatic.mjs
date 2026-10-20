import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readRun } from './run.mjs';
import { compareGeometry } from './tuning-geometry.mjs';
import { settingsFor } from './profiles.mjs';
import { distanceM } from './engines.mjs';

const [id03, id02, id01] = process.argv.slice(2);
if (!id03 || !id02) throw new Error('Usage: node experiments/routing/check-automatic.mjs SCENARIO_03_RUN SCENARIO_02_RUN [SCENARIO_01_RUN]');
const settings = (await readRun(id03)).settings;
const preset = settingsFor(settings);
const local = new URL('./.local/', import.meta.url);
const feedbackFile = 'feedback/03-eggenberg-junction-cyclepath-v1-accepted-2026-10-18.json';
const feedback = JSON.parse(await readFile(new URL(feedbackFile, local), 'utf8'));
const accepted03 = await readRun(feedback.runId);
const original = await readRun('2026-10-17T20-32-45-933Z-72a1c9bd');
const geometry = result => result.normalized.geometry.coordinates;
const reference03 = geometry(accepted03.results.find(r => r.id === feedback.resultId));
const acceptedProfile = '.local/brouter/profiles2/richi-cyclepath-v1.brf';
assert.equal(createHash('sha256').update(await readFile(new URL(acceptedProfile, import.meta.url))).digest('hex'), accepted03.provenance.snapshots[acceptedProfile].sha256, 'Keep the accepted v1 profile unchanged.');
const reference02 = original.results.find(r => r.id === '02-parallel-mur-automatic-graphhopper-1');
const report = {
  settings, createdAt: new Date().toISOString(),
  references: { scenario03: { feedbackFile, runId: feedback.runId, resultId: feedback.resultId }, scenario02: { runId: original.id, resultId: reference02.id } },
  results: [],
  limitations: [
    'Agreement is measured on stored geometry, sampled every five metres in both directions. It is not a safety or access assessment.',
    'The rider accepted the cyclepath-v1 Chosen roads route for scenario 03. Matching it does not establish general approval of a new profile.',
    'Settings remain experimental. Other tuning scenarios still need rider review; held-out evaluation remains unused.',
  ],
};
const comparisons = [[id03, '03-eggenberg-junction', reference03], [id02, '02-parallel-mur', geometry(reference02)]];
if (id01) {
  const reference = JSON.parse(await readFile(new URL('mur-v3-reference.geojson', local), 'utf8'));
  const feedback01 = JSON.parse(await readFile(new URL(reference.properties.feedbackFile, local), 'utf8'));
  assert.equal(reference.properties.runId, feedback01.runId);
  const source = await readRun(feedback01.runId);
  const sections = reference.properties.sourceSegments.map(segment => geometry(source.results.find(r => r.id === segment.resultId)).slice(segment.fromIndex, segment.throughIndex + 1).map(c => c.slice(0,2)));
  assert.equal(sections.length, 2);
  assert.ok(distanceM(sections[0].at(-1), sections[1][0]) < 1, 'Reference sections must meet without an invented connector.');
  assert.deepEqual(reference.geometry.coordinates, [...sections[0], ...sections[1].slice(1)]);
  const previousProfile = '.local/brouter/profiles2/richi-network-v2.brf';
  assert.equal(createHash('sha256').update(await readFile(new URL(previousProfile, import.meta.url))).digest('hex'), source.provenance.snapshots[previousProfile].sha256);
  report.references.scenario01 = reference.properties;
  report.limitations.push('Scenario 01 joins the rider-selected brown opening to green at their last common vertex before the long divergence. This transition is inferred from stored geometry, not a coordinate supplied by the rider.');
  report.limitations.push('Scenario 01 includes a short section tagged bicycle=dismount and gravel. The rider prefers keeping this path over a road detour, recorded in feedback/01-mur-construction-preference-2026-10-18.json. Retain the construction/dismount note until reopening is verified.');
  comparisons.push([id01, '01-mur-north', reference.geometry.coordinates]);
}
for (const [id, caseId, reference] of comparisons) {
  const run = await readRun(id);
  assert.equal(run.status, 'completed');
  assert.equal(run.settings, settings);
  assert.equal(run.engines.brouter.profile, preset.brouterProfile);
  for (const file of ['graphhopper.yml', '.local/brouter/profiles2/richi-road.brf']) {
    assert.equal(run.provenance.snapshots[file].sha256, original.provenance.snapshots[file].sha256, `${file} must stay unchanged.`);
  }
  const scenario = run.scenarios.find(s => s.id === caseId);
  for (const variant of caseId.startsWith('03') ? ['automatic', 'selected'] : ['automatic']) {
    const result = run.results.find(r => r.caseId === caseId && r.engineId === 'brouter' && r.variant === variant);
    assert.equal(result.status, 'ok');
    const request = new URL(result.request.url);
    assert.equal(request.searchParams.get('profile'), preset.brouterProfile);
    const expectedPoints = variant === 'automatic' ? scenario.points.filter(p => p.role === 'stop') : scenario.points;
    assert.deepEqual(result.points, expectedPoints);
    assert.equal(request.searchParams.get('lonlats'), expectedPoints.map(p => p.coord.join(',')).join('|'));
    if (variant === 'automatic') assert.equal(expectedPoints.length, 2, 'No hidden shaping points in Automatic.');
    const measurement = compareGeometry(geometry(result), reference);
    assert.ok(measurement.maximumSampledSeparationM < 1, 'Route must match the accepted geometry.');
    assert.ok(Math.abs(measurement.lengthDifferenceM) < 2, 'No added backtracking or shortcuts.');
    assert.ok(measurement.startSeparationM < 1 && measurement.endSeparationM < 1, 'Same endpoints and direction.');
    report.results.push({ runId: id, resultId: result.id, pointCount: expectedPoints.length, request: result.request, ...measurement });
    console.log(`${caseId} ${variant}: ${expectedPoints.length} points; ${measurement.maximumSampledSeparationM.toFixed(2)} m maximum sampled separation.`);
  }
}
report.measurementSourceSha256 = createHash('sha256').update(await readFile(new URL('./tuning-geometry.mjs', import.meta.url))).digest('hex');
await writeFile(new URL(`${settings}-checks.json`, local), JSON.stringify(report, null, 2));
console.log('Passed: Automatic uses only two endpoints and matches the reviewed reference geometry; scenario 03 Chosen roads and scenario 02 are preserved.');

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { readRun } from './run.mjs';
import { compareGeometry } from './tuning-geometry.mjs';

const [thalId, westernId] = process.argv.slice(2);
if (!thalId || !westernId) throw new Error('Usage: node experiments/routing/check-surfaces.mjs THAL_RUN WESTERN_RUN');
const report = { settings: 'surface-v4', comparisons: [], surfaces: {} };
for (const [id, previousId, caseId] of [
  [thalId, '2026-10-18T17-04-18-100Z-16055074', '04-thal-surface'],
  [westernId, '2026-10-18T16-17-33-504Z-455e69f7', '06-multiple-shapes'],
]) {
  const run = await readRun(id), previous = await readRun(previousId);
  assert.equal(run.settings, report.settings);
  assert.equal(run.status, 'completed');
  assert.equal(run.engines.brouter.profile, 'richi-surface-v4');
  assert.deepEqual(run.scenarios, previous.scenarios, 'Only the profile should change.');
  for (const result of run.results) {
    assert.equal(result.caseId, caseId);
    const reference = previous.results.find(item => item.id === result.id);
    assert.ok(reference);
    if (caseId === '06-multiple-shapes' || result.engineId !== 'brouter') {
      assert.deepEqual(result.normalized.geometry, reference.normalized.geometry, 'Preserve western routes and unchanged comparison engines.');
      report.comparisons.push({ runId: id, resultId: result.id, previousId, identicalGeometry: true });
    }
  }
  if (caseId !== '04-thal-surface') continue;
  const result = run.results.find(item => item.engineId === 'brouter' && item.variant === 'automatic');
  assert.equal(result.points.length, 2, 'Automatic must not add hidden shaping points.');
  const raw = JSON.parse(await readFile(new URL(`./.local/runs/${id}/${result.id}.response.txt`, import.meta.url), 'utf8'));
  const [header, ...messages] = raw.features[0].properties.messages;
  for (const row of messages) {
    const surface = /(?:^|\s)surface=([^\s]+)/.exec(row[header.indexOf('WayTags')])?.[1] ?? 'unknown';
    report.surfaces[surface] = (report.surfaces[surface] ?? 0) + Number(row[header.indexOf('Distance')]);
  }
  for (const surface of ['unpaved', 'gravel', 'ground', 'dirt', 'grass', 'compacted', 'sand', 'pebblestone', 'fine_gravel', 'earth', 'mud', 'clay', 'rock']) {
    assert.equal(report.surfaces[surface] ?? 0, 0, `Thal still contains mapped ${surface}.`);
  }
  assert.ok(report.surfaces.unknown > 0, 'Do not treat missing surface as paved.');
  report.thal = { runId: id, resultId: result.id, distanceM: result.normalized.distanceM,
    comparisonToGreen: compareGeometry(result.normalized.geometry.coordinates, previous.results.find(item => item.engineId === 'graphhopper' && item.variant === 'automatic').normalized.geometry.coordinates),
    limitations: 'Mapped surface evidence only. Wood and unknown surfaces remain. The draft Chosen roads variant is not covered by the no-unpaved assertion.' };
}
await writeFile(new URL('./.local/surface-v4-surface-checks.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log('Passed: Thal Automatic avoids mapped loose surfaces; western variants and comparison engines are unchanged.');
console.log(JSON.stringify(report.surfaces));

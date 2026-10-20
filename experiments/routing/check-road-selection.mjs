import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { readRun } from './run.mjs';
import { compareGeometry } from './tuning-geometry.mjs';

const id = process.argv[2];
if (!id) throw new Error('Usage: node experiments/routing/check-road-selection.mjs THAL_REVISION_3_RUN');
const run = await readRun(id);
const previous = await readRun('2026-10-18T17-16-09-220Z-71b485dc');
assert.equal(run.status, 'completed');
assert.equal(run.settings, 'surface-v4');
assert.equal(run.scenarios[0].revision, 3);
const report = { runId: id, referenceRunId: previous.id, automaticUnchanged: true, chosenRoads: [] };
for (const result of run.results) {
  const priorAutomatic = previous.results.find(item => item.variant === 'automatic' && item.engineId === result.engineId);
  assert.ok(priorAutomatic);
  if (result.variant === 'automatic') {
    assert.equal(result.points.length, 2);
    assert.deepEqual(result.normalized.geometry, priorAutomatic.normalized.geometry);
    continue;
  }
  assert.equal(result.points.length, 4);
  assert.deepEqual(result.points, run.scenarios[0].points);
  const reference = result.engineId === 'brouter'
    ? previous.results.find(item => item.engineId === 'graphhopper' && item.variant === 'automatic')
    : priorAutomatic;
  const comparison = compareGeometry(result.normalized.geometry.coordinates, reference.normalized.geometry.coordinates);
  assert.ok(comparison.maximumSampledSeparationM < 1, 'Chosen roads must match the reviewed main-road geometry.');
  assert.ok(Math.abs(comparison.lengthDifferenceM) < 2, 'Do not add backtracking to visit the road points.');
  report.chosenRoads.push({ resultId: result.id, referenceResultId: reference.id, distanceM: result.normalized.distanceM, comparison });
}
await writeFile(new URL('./.local/thal-main-road-selection-checks.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log('Passed: Automatic unchanged; all three Chosen roads results follow the reviewed main-road line without added backtracking.');

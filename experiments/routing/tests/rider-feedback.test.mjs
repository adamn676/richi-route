import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyRiderRejections, geometryHash } from '../rider-feedback.mjs';

test('rider rejection follows the exact route across runs without rejecting other routes or altering saved evidence', async () => {
  const { rejections } = JSON.parse(await readFile(new URL('../rider-rejections.json', import.meta.url), 'utf8'));
  const geometry = { type: 'LineString', coordinates: [[15, 47], [15.01, 47.01]] };
  const result = { caseId: '04-thal-surface', engineId: 'brouter', variant: 'automatic', status: 'ok', normalized: { geometry } };
  const rejection = { ...rejections[0], geometrySha256: geometryHash(geometry) };
  const run = { id: 'new-run', results: [result] };
  assert.deepEqual(applyRiderRejections(run, [rejection]).results[0].riderRejection, rejection);
  assert.equal(run.results[0].riderRejection, undefined);
  for (const change of [
    { engineId: 'ors' }, { caseId: 'other-case' }, { variant: 'selected' },
    { status: 'error', normalized: null },
    { normalized: { geometry: { ...geometry, coordinates: [[15, 47], [15.02, 47.01]] } } },
  ]) assert.equal(applyRiderRejections({ results: [{ ...result, ...change }] }, [rejection]).results[0].riderRejection, undefined);
  assert.equal(rejections.length, 2);
  assert.deepEqual(new Set(rejections.map(item => item.engineId)), new Set(['brouter', 'graphhopper']));
});

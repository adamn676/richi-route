import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationFingerprint, validateEvaluation } from '../evaluation.mjs';
import { runBenchmark } from '../run.mjs';

const evidence = {
  assets: { assets: [{ file: 'data/map.rd5', sha256: 'map-a' }] },
  snapshots: { 'profile.brf': { sha256: 'profile-a' }, 'scenarios.json': { sha256: 'cases-a' } },
  brouterPatch: { patchedJarSha256: 'jar-a' },
  git: { commit: 'checkpoint' },
};
const settings = 'thal-local-v1';
const frozen = { schemaVersion: 1, fingerprint: evaluationFingerprint(settings, true, evidence) };

test('evaluation permits unchanged inputs despite unrelated repository or runtime metadata', () => {
  const current = structuredClone(evidence);
  current.git.commit = 'docs-only';
  current.snapshots = Object.fromEntries(Object.entries(current.snapshots).reverse());
  assert.doesNotThrow(() => validateEvaluation(frozen, settings, true, current));
});

test('evaluation rejects changes to settings, engine selection, map, profile, scenario or patched engine', () => {
  assert.throws(() => validateEvaluation(frozen, 'surface-v4', true, evidence), /inputs changed/);
  assert.throws(() => validateEvaluation(frozen, settings, false, evidence), /inputs changed/);
  for (const change of [
    value => { value.assets.assets[0].sha256 = 'map-b'; },
    value => { value.snapshots['profile.brf'].sha256 = 'profile-b'; },
    value => { value.snapshots['scenarios.json'].sha256 = 'cases-b'; },
    value => { value.brouterPatch.patchedJarSha256 = 'jar-b'; },
  ]) {
    const current = structuredClone(evidence);
    change(current);
    assert.throws(() => validateEvaluation(frozen, settings, true, current), /inputs changed/);
  }
});

test('freeze IDs cannot escape their directory or be used to mix tuning and evaluation', async () => {
  for (const evaluationFreeze of ['../outside', '', {}, 1]) {
    await assert.rejects(runBenchmark({ caseId: '07-south-quiet', evaluationFreeze }), /Invalid evaluation freeze ID/);
  }
  await assert.rejects(runBenchmark({ split: 'all', evaluationFreeze: 'round-one' }), /only evaluation/);
  await assert.rejects(runBenchmark({ caseId: '01-mur-north', evaluationFreeze: 'round-one' }), /only evaluation/);
});

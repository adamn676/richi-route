import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import config from '../config/routing-rules.json' with { type: 'json' };
import generated from '../src/config/routing-rules.generated.json' with { type: 'json' };
import { compileRules, validateRules, validateLookupTags } from '../scripts/routing-rules.mjs';
import { localRulesProfile } from '../scripts/routing-profile.mjs';

test('the browser artifact and engine rules come from the same validated configuration', () => {
  const compiled = compileRules(config);
  assert.deepEqual(compiled.client, generated);
  assert.match(compiled.engine, /turn\tries-bicycle-turn\t195539841\t137103009/);
  assert.match(compiled.engine, /avoidance\tthal-road-preference\t195377673\t137098973\t5\t50/);
  assert.equal(compiled.engine.split('\n').filter(l => l.startsWith('segment\t')).length, 4);
});

test('conflicting, malformed and ambiguous rules fail before producing engine data', () => {
  for (const mutate of [
    c => { c.schemaVersion = 2; },
    c => { c.rules.push(structuredClone(c.rules[0])); },
    c => { c.rules[0].kind = 'unknown'; },
    c => { c.rules[0].mode = 'car'; },
    c => { c.rules[0].costfactor = -1; },
    c => { c.rules[0].originalCostfactor = 10000; },
    c => { c.rules[0].segments[0][0] = [200, 90]; },
    c => { c.rules[0].segments[0][0] = [12, 47]; },
    c => { c.rules[0].segments[0][0][0] += .00000001; },
    c => { c.rules[0].segments[0][1] = c.rules[0].segments[0][0]; },
    c => { c.rules[0].absentTags.push('bicycle'); },
    c => { c.rules[0].forbiddenTags.bicycle = ['dismount']; },
    c => { c.rules[0].requiredTags.highway = 'steps\t0'; },
    c => { c.rules[0].surprise = true; },
    c => { c.rules[0].reviewedTiles = {}; },
    c => { c.rules[1].reviewedTiles['E15_N45.rd5'] = 'a'.repeat(64); },
    c => { c.rules[1].restriction = 'only'; },
    c => { c.rules[2].weight = Infinity; },
    c => { c.rules[2].radiusMeters = 0; },
    c => { c.rules.push({ ...structuredClone(c.rules[0]), id: 'conflicting-passage' }); },
    c => { c.rules.push({ ...structuredClone(c.rules[1]), id: 'conflicting-turn' }); },
  ]) {
    const changed = structuredClone(config); mutate(changed);
    assert.throws(() => validateRules(changed), /Routing rules:/);
  }
});

test('tag guards must use encoded primary values, not missing tags or lossy aliases', () => {
  const data = { rules: [{ enabled: true, kind: 'passage', id: 'test', requiredTags: { foot: 'yes' }, forbiddenTags: {}, absentTags: [] }] };
  const lookups = '---context:way\nfoot;1 yes allowed\n---context:node\nbarrier;1 gate\n';
  assert.doesNotThrow(() => validateLookupTags(data, lookups));
  data.rules[0].requiredTags.foot = 'allowed';
  assert.throws(() => validateLookupTags(data, lookups), /primary value/);
  data.rules[0].requiredTags = { barrier: 'gate' };
  assert.throws(() => validateLookupTags(data, lookups), /not available/);
});

test('adding, disabling and changing rules changes the revision; JSON key order does not', () => {
  const initial = compileRules(config);
  const reordered = { rules: config.rules.map(r => Object.fromEntries(Object.entries(r).reverse())), schemaVersion: 1 };
  assert.equal(compileRules(reordered).revision, initial.revision);
  const added = structuredClone(config);
  added.rules.push({ ...structuredClone(config.rules[0]), id: 'another-passage', direction: 'forward',
    segments: [[[16, 48], [16.000001, 48.000001]]], notice: 'Another place.' });
  assert.notEqual(compileRules(added).revision, initial.revision);
  assert.equal(compileRules(added).client.notices.length, 2);
  added.rules.at(-1).enabled = false;
  assert.equal(compileRules(added).client.notices.length, 1);
  assert.notEqual(compileRules(added).revision, initial.revision);
});

test('the new profile preserves the existing costs and retains the configured guard tags', async () => {
  const original = await readFile(new URL('../experiments/routing/brouter-patch/fixtures/richi-weidweg-v1.brf', import.meta.url), 'utf8');
  const compiled = compileRules(config);
  const profile = localRulesProfile(original, compiled.retainedTags);
  assert.ok(!profile.includes('richiroute_weidweg_push'));
  assert.ok(!profile.includes('assign weidweg_ramp'));
  assert.match(profile, /assign richiroute_local_rules = true/);
  assert.equal(profile.slice(profile.indexOf('assign surfacepenalty')), original.slice(original.indexOf('assign surfacepenalty')));
  assert.throws(() => localRulesProfile('unexpected profile', []), /profile changed/);
});

test('a changed map tile requires review and leaves prepared artifacts untouched', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'richiroute-data-review-'));
  try {
    await mkdir(path.join(directory, 'bundle/data'), { recursive: true });
    await mkdir(path.join(directory, 'output'), { recursive: true });
    await writeFile(path.join(directory, 'bundle/data/E15_N45.rd5'), 'changed data');
    await writeFile(path.join(directory, 'output/rules.tsv'), 'previous rules');
    const result = spawnSync(process.execPath, ['scripts/prepare-routing-rules.mjs'], { encoding: 'utf8', env: { ...process.env,
      BROUTER_BUNDLE: path.join(directory, 'bundle'), ROUTING_RULES_OUTPUT: path.join(directory, 'output') } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Map data changed: E15_N45.rd5/);
    assert.match(result.stderr, /weidweg-push-through, ries-bicycle-turn, thal-road-preference/);
    assert.equal(await readFile(path.join(directory, 'output/rules.tsv'), 'utf8'), 'previous rules');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

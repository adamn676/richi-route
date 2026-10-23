import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import config from '../config/routing-rules.json' with { type: 'json' };
import search from '../src/config/routing-search.json' with { type: 'json' };
import { compileRules } from '../scripts/routing-rules.mjs';
import { nativeReportDirectory, startNativeRouter } from '../experiments/routing/native-router.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jar = new URL('../experiments/routing/.local/brouter-local-rules/brouter-local-rules.jar', import.meta.url);
const originalJarHash = hash(await readFile(jar));
const passage = [[15.397965, 47.103194], [15.397308, 47.102517]];
const turn = [[15.521873, 47.095702], [15.503735, 47.105271]];
const thal = [[15.392482, 47.099327], [15.3428, 47.0759]];
const fixtures = path.join(nativeReportDirectory, 'fixtures');
await mkdir(fixtures, { recursive: true });
const report = { createdAt: new Date().toISOString(), jarSha256: originalJarHash, checks: [] };
async function withRules(name, data, check) {
  const compiled = compileRules(data), rulesFile = path.join(fixtures, name + '.tsv');
  await writeFile(rulesFile, compiled.engine);
  const engine = await startNativeRouter({ name: 'engine-test-' + name, port: 17781, rulesFile });
  async function request(points, overrides = {}) {
    const query = new URLSearchParams({ profile: compiled.client.profile, lonlats: points.map(p => p.join(',')).join('|'), format: 'geojson', alternativeidx: '0',
      ...Object.fromEntries(Object.entries({ ...search, ...compiled.client.parameters, ...overrides }).map(([k, v]) => ['profile:' + k, String(v)])) });
    return fetch(`http://127.0.0.1:${engine.port}/brouter?${query}`, { signal: AbortSignal.timeout(70000) });
  }
  async function route(points, overrides = {}) {
    const response = await request(points, overrides);
    const text = await response.text();
    assert.ok(response.ok, text);
    return JSON.parse(text).features[0];
  }
  try { await check(route, request); report.checks.push(name); }
  finally { await engine.stop(); }
}
function usesSteps(feature) {
  const [header, ...rows] = feature.properties.messages;
  return rows.some(row => /(?:^|\s)highway=steps(?:\s|$)/.test(row[header.indexOf('WayTags')]));
}
const disabled = structuredClone(config);
disabled.rules.forEach(r => { r.enabled = false; });
await withRules('disable-all-with-data', disabled, async route => {
  assert.equal(usesSteps(await route(passage)), false);
  assert.equal(Number((await route(turn)).properties['track-length']), 5158);
  assert.notEqual(Number((await route(thal)).properties['track-length']), 5883);
});
const forward = structuredClone(config);
forward.rules[0].direction = 'forward';
forward.rules[0].id = 'configured-passage';
await withRules('directed-and-renamed-with-data', forward, async (route, request) => {
  const mismatch = await request(passage, { richiroute_rules_3: '1' });
  assert.equal(mismatch.status, 400, 'A different rule version is a client error');
  assert.equal((await mismatch.text()).trim(), 'local routing rules version mismatch');
  for (const inverseRouting of [0, 1]) {
    assert.equal(usesSteps(await route(passage, { inverseRouting })), true, 'Configured forward passage');
    assert.equal(usesSteps(await route([...passage].reverse(), { inverseRouting })), false, 'Reverse remains restricted');
  }
  for (const key of ['validForCars', 'validForFoot']) assert.equal(usesSteps(await route(passage, { [key]: 1 })), false);
  const variants = await Promise.all([1, 0, 1, 0].map(value => route(turn, { richiroute_local_rules: value })));
  assert.deepEqual(variants.map(f => Number(f.properties['track-length'])), [4898, 5158, 4898, 5158], 'Concurrent profile requests do not mutate shared restrictions');
});
assert.equal(hash(await readFile(jar)), originalJarHash, 'Configuration changes require no engine rebuild');
await writeFile(path.join(nativeReportDirectory, 'engine-configuration-tests.json'), JSON.stringify(report, null, 2) + '\n');
console.log('Data-only rule disablement, renamed/directed passages, inverse search, mode guards and concurrent profile isolation passed.');

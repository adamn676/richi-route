import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { requestFor, normalize } from '../experiments/routing/engines.mjs';
import { assessReviewedRoute, geometryHash } from '../experiments/routing/reviewed-routes.mjs';

const endpoint = new URL(process.argv[2] ?? 'http://127.0.0.1:17777');
assert.equal(endpoint.hostname, '127.0.0.1');
const suite = JSON.parse(await readFile(new URL('../experiments/routing/fixtures/reviewed-routes.json', import.meta.url), 'utf8'));
const target = suite.routes.find(r => r.id === '11-western-loop-selected');
const report = { createdAt: new Date().toISOString(), endpoint: endpoint.origin, results: [] };
async function route(id, points, settings, overrides = {}) {
  const url = new URL(requestFor('brouter', points, settings).url);
  url.port = endpoint.port;
  for (const [key, value] of Object.entries(overrides)) url.searchParams.set('profile:' + key, String(value));
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(70000) });
  assert.equal(response.status, 200);
  const raw = await response.json();
  const normalized = normalize('brouter', raw);
  report.results.push({ id, request: url.href, raw });
  return normalized.geometry.coordinates;
}
const points = [195, 209].map(i => ({ coord: target.coordinates[i], role: 'stop' }));
for (const reverse of [false, true]) {
  const ordered = reverse ? [...points].reverse() : points;
  const coordinates = target.coordinates.slice(195, 210);
  if (reverse) coordinates.reverse();
  const expected = { points: ordered, coordinates };
  const scoped = await route(`passage-${reverse}`, ordered, 'local-rules-v1');
  assert.ok(assessReviewedRoute(expected, scoped).matches, 'Uses only the accepted passage in both directions');
  const baseline = await route(`baseline-${reverse}`, ordered, 'local-rules-v1', { richiroute_local_rules: 0 });
  assert.ok(!assessReviewedRoute(expected, baseline).matches, 'Profile without opt-in still avoids the stairs');
}
for (const [id, overrides] of [
  ['explicit-opt-out', { richiroute_local_rules: 0 }],
  ['car-mode', { validForCars: 1 }],
  ['foot-mode', { validForFoot: 1 }],
]) {
  const line = await route(id, points, 'local-rules-v1', overrides);
  assert.ok(!assessReviewedRoute({ points, coordinates: target.coordinates.slice(195, 210) }, line).matches, id);
}
for (const reference of suite.routes.filter(r => r.expectation === 'preserve')) {
  assert.equal(geometryHash(reference.coordinates), reference.geometrySha256);
  assert.ok(assessReviewedRoute(reference, await route(reference.id, reference.points, 'local-rules-v1')).matches, reference.id);
}
const whole = await route('western-loop', target.points, 'local-rules-v1');
for (const index of [200, 201, 202, 203]) {
  assert.ok(whole.some(c => Math.abs(c[0] - target.coordinates[index][0]) < 0.000001 && Math.abs(c[1] - target.coordinates[index][1]) < 0.000001));
}
report.westernTarget = assessReviewedRoute(target, whole);
for (const { raw } of report.results) {
  const [header, ...rows] = raw.features[0].properties.messages;
  const tags = header.indexOf('WayTags');
  for (const row of rows.filter(r => /highway=steps\b/.test(r[tags]))) {
    const lon = Number(row[header.indexOf('Longitude')]), lat = Number(row[header.indexOf('Latitude')]);
    assert.ok([200, 201, 202, 203].some(i => Math.round(target.coordinates[i][0] * 1e6) === lon && Math.round(target.coordinates[i][1] * 1e6) === lat));
    assert.match(row[tags], /bicycle=dismount\b/);
    assert.match(row[tags], /ramp:bicycle=yes\b/);
  }
}
const file = new URL(`../experiments/routing/.local/weidweg-check-${report.createdAt.replaceAll(/[:.]/g, '-')}.json`, import.meta.url);
await writeFile(file, JSON.stringify(report, null, 2) + '\n');
console.log('Weidweg works in both directions; opt-out stays restricted; all 14 protected routes preserved; step tags retained.');
console.log(file.pathname);

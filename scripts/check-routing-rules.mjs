import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileRules } from './routing-rules.mjs';
import { distanceMeters } from '../src/domain/route-model.ts';
import search from '../src/config/routing-search.json' with { type: 'json' };

const root = new URL('../', import.meta.url);
const data = JSON.parse(await readFile(process.env.ROUTING_RULES_CONFIG ?? new URL('config/routing-rules.json', root), 'utf8'));
const compiled = compileRules(data);
const endpoint = new URL('/brouter', process.argv[2] ?? 'http://127.0.0.1:17777');
assert.equal(endpoint.hostname, '127.0.0.1', 'Checks use a local routing engine');
const report = { createdAt: new Date().toISOString(), revision: compiled.revision, results: [] };
async function route(points) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ profile: compiled.client.profile, lonlats: points.map(p => p.join(',')).join('|'), format: 'geojson', alternativeidx: '0',
    ...Object.fromEntries(Object.entries({ ...search, ...compiled.client.parameters }).map(([k, v]) => ['profile:' + k, String(v)])) });
  const response = await fetch(url, { signal: AbortSignal.timeout(70000) });
  const body = await response.text();
  assert.ok(response.ok, body);
  const line = JSON.parse(body).features.find(f => f.geometry.type === 'LineString');
  assert.ok(line, 'The engine returns route geometry');
  return line;
}
for (const rule of data.rules.filter(r => r.enabled)) {
  if (rule.kind === 'passage') {
    for (const segment of rule.segments) for (const points of rule.direction === 'both' ? [segment, [...segment].reverse()] : [segment]) {
      const line = await route(points), coordinates = line.geometry.coordinates;
      const length = distanceMeters(...points);
      assert.ok(distanceMeters(coordinates[0], points[0]) < .3 && distanceMeters(coordinates.at(-1), points[1]) < .3, rule.id + ': endpoints changed');
      assert.ok(coordinates.every(p => distanceMeters(points[0], p) + distanceMeters(p, points[1]) < length + .3), rule.id + ': the configured segment is not usable');
      const [header, ...messages] = line.properties.messages;
      const tagsIndex = header.indexOf('WayTags'), costIndex = header.indexOf('CostPerKm');
      assert.ok(messages.some(row => {
        const tags = Object.fromEntries(String(row[tagsIndex]).split(' ').filter(Boolean).map(tag => tag.split('=')));
        return Number(row[costIndex]) === Math.round(rule.costfactor * 1000)
          && Object.entries(rule.requiredTags).every(([key, value]) => tags[key] === value)
          && Object.entries(rule.forbiddenTags).every(([key, values]) => !values.includes(tags[key]))
          && rule.absentTags.every(key => !(key in tags));
      }), rule.id + ': expected tag guards and passage cost were not observed');
      report.results.push({ id: rule.id, check: 'passage geometry, tags and cost', points });
    }
  } else if (rule.kind === 'turn') {
    const line = await route([rule.from, rule.to]);
    const coords = line.geometry.coordinates;
    assert.ok(coords.some((p, i) => i > 0 && i < coords.length - 1 && distanceMeters(p, rule.via) < .2
      && distanceMeters(coords[i - 1], rule.from) < .2 && distanceMeters(coords[i + 1], rule.to) < .2), rule.id + ': the directed turn was not observed');
    report.results.push({ id: rule.id, check: 'directed turn geometry' });
  } else {
    const line = await route([rule.center, rule.center]);
    assert.ok(distanceMeters(line.geometry.coordinates[0], rule.center) < rule.radiusMeters + .2, rule.id + ': no mapped road at the avoidance center');
    report.results.push({ id: rule.id, check: 'mapped avoidance center; preference outcome requires its route regression' });
  }
}
const file = new URL('experiments/routing/.local/local-routing-rules/active-rule-checks.json', root);
await writeFile(file, JSON.stringify(report, null, 2) + '\n');
console.log(`${report.results.length} active-rule checks passed. ${fileURLToPath(file)}`);

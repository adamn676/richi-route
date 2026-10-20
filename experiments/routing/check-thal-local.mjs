import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { readRun } from './run.mjs';
import { requestFor, normalize } from './engines.mjs';
import { compareGeometry } from './tuning-geometry.mjs';

const settings = 'thal-local-v1';
const output = new URL('.local/thal-local-probes/', import.meta.url);
await mkdir(output, { recursive: true });
const report = [];
async function check(name, points, reference) {
  const url = new URL(requestFor('brouter', points, settings).url);
  const response = await fetch(url);
  const raw = await response.json();
  assert.equal(response.status, 200, name);
  const normalized = normalize('brouter', raw);
  const comparison = reference ? compareGeometry(normalized.geometry.coordinates, reference) : null;
  report.push({ name, points, url: url.href, normalized, comparison, raw });
  console.log(name, normalized.distanceM, comparison?.maximumSampledSeparationM ?? 'new case');
  return normalized;
}
for (const id of [
  '2026-10-18T17-16-22-502Z-b6a9b42f',
  '2026-10-18T17-16-23-154Z-53c51622',
  '2026-10-18T17-16-23-863Z-cf312ae6',
  '2026-10-18T17-16-24-332Z-8ce416be',
  '2026-10-19T17-58-35-647Z-3959e58a',
]) {
  for (const reference of (await readRun(id)).results.filter(r => r.engineId === 'brouter')) {
    const result = await check(`${reference.caseId}/${reference.variant}`, reference.points, reference.normalized.geometry.coordinates);
    assert.deepEqual(result.geometry, reference.normalized.geometry);
  }
}
const thal = (await readRun('2026-10-18T17-16-09-220Z-71b485dc')).results.find(r => r.engineId === 'graphhopper' && r.variant === 'automatic');
const result = await check('Thal automatic',thal.points,thal.normalized.geometry.coordinates);
assert.equal(result.distanceM,5883);
assert.ok(report.at(-1).comparison.maximumSampledSeparationM < 1);
await check('Thal reverse',[...thal.points].reverse(),thal.normalized.geometry.coordinates.toReversed());
assert.ok(report.at(-1).comparison.maximumSampledSeparationM < 1);
const points = coords => coords.map(coord => ({ role: 'stop', coord }));
const short = await check('Explicit short cycle-path trip', points([[15.377892,47.099181],[15.377421,47.098681]]));
assert.equal(short.distanceM,66);
const chosen = await check('Explicit cycle-path shaping point', [thal.points[0], {role:'shape',coord:[15.377673,47.098973]},thal.points[1]]);
assert.ok(chosen.geometry.coordinates.some(([x,y]) => x === 15.377673 && y === 47.098973));
const ries = await check('Ries junction',points([[15.521873,47.095702],[15.503735,47.105271]]));
assert.equal(ries.distanceM,4898);
await writeFile(new URL('regression.json',output),JSON.stringify({settings,report},null,2));

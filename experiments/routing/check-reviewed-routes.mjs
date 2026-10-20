import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { route } from './engines.mjs';
import { provenance } from './run.mjs';
import { settingsFor } from './profiles.mjs';
import { assessReviewedRoute, geometryHash } from './reviewed-routes.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--settings')) throw new Error('Usage: node experiments/routing/check-reviewed-routes.mjs [--settings NAME]');
const suite = JSON.parse(await readFile(new URL('./fixtures/reviewed-routes.json', import.meta.url), 'utf8'));
const settings = args[1] ?? suite.baselineSettings;
settingsFor(settings);
const evidence = await provenance(settings, false);
const report = { createdAt: new Date().toISOString(), settings, fixtureSha256: geometryHash(suite), provenance: evidence, results: [], regressions: 0, errors: 0, matchedTargets: 0, openTargets: 0 };
const directory = new URL(`.local/reviewed-route-checks/${report.createdAt.replaceAll(/[:.]/g, '-')}/`, import.meta.url);
await mkdir(directory, { recursive: true });
for (const reference of suite.routes) {
  assert.equal(geometryHash(reference.coordinates), reference.geometrySha256, `Reviewed geometry changed: ${reference.id}`);
  const result = await route('brouter', reference.points, fetch, settings);
  if (result.rawText !== null) await writeFile(new URL(reference.id + '.response.json', directory), result.rawText);
  const assessment = result.status === 'ok' ? assessReviewedRoute(reference, result.normalized.geometry.coordinates) : null;
  const status = !assessment ? 'error' : reference.expectation === 'preserve' ? assessment.matches ? 'preserved' : 'regression' : assessment.matches ? 'target-matched' : 'target-open';
  if (status === 'error') report.errors++;
  if (status === 'regression') report.regressions++;
  if (status === 'target-open') report.openTargets++;
  if (status === 'target-matched') report.matchedTargets++;
  report.results.push({ id: reference.id, expectation: reference.expectation, status, request: result.request, responseMs: result.responseMs, error: result.error, assessment });
  console.log(`${reference.id}: ${status}${assessment ? `; ${assessment.geometry.lengthDifferenceM.toFixed(1)} m length difference` : `; ${result.error}`}`);
}
await writeFile(new URL('report.json', directory), JSON.stringify(report, null, 2) + '\n');
console.log(`Saved ${fileURLToPath(new URL('report.json', directory))}`);
console.log(`${report.regressions} regressions; ${report.errors} routing errors; ${report.openTargets} rider targets still open.`);
if (report.regressions || report.errors) process.exitCode = 1;

// Requires the existing local BRouter and editor dev server; writes private evidence only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createPinia, setActivePinia } from 'pinia';
import { useRouteStore } from '../src/stores/route.store.ts';
import { getSegments } from '../src/utils/geometry.ts';
import { compareGeometry } from '../experiments/routing/tuning-geometry.mjs';

const originalFetch = globalThis.fetch;
let requestCount = 0;
globalThis.fetch = (url, options) => {
  requestCount++;
  return originalFetch(new URL(url, 'http://127.0.0.1:5173/'), options);
};
async function idle(store) {
  const deadline = performance.now() + 90000;
  while (store.pendingSnapCount || store.pendingLegCount || (store.hasAirLines && !store.errorMessage)) {
    if (performance.now() > deadline) throw new Error('Routing did not finish');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(store.errorMessage, null);
}
const cases = [
  ['2026-10-18T17-16-22-502Z-b6a9b42f', 'automatic'],
  ['2026-10-18T17-16-23-154Z-53c51622', 'automatic'],
  ['2026-10-18T17-16-23-863Z-cf312ae6', 'automatic'],
  ['2026-10-19T17-58-35-647Z-3959e58a', 'automatic'],
  ['2026-10-18T17-16-24-332Z-8ce416be', 'selected'],
  ['2026-10-18T17-16-24-332Z-8ce416be', 'edited'],
];
const comparisons = [];
for (const [runId, variant] of cases) {
  const run = JSON.parse(await fs.readFile(`experiments/routing/.local/runs/${runId}/run.json`, 'utf8'));
  const reference = run.results.find(result => result.variant === variant && result.id.endsWith('-brouter-1'));
  setActivePinia(createPinia());
  const store = useRouteStore();
  store.resetRoute(reference.points.map(point => point.coord));
  await idle(store);
  const geometry = Object.values(store.legs).flatMap(leg => leg.coordinates);
  const comparison = compareGeometry(geometry, reference.normalized.geometry.coordinates);
  assert.equal(comparison.candidateOutside3mM, 0);
  assert.equal(comparison.referenceMissed3mM, 0);
  assert.ok(Math.abs(comparison.lengthDifferenceM) < 1);
  comparisons.push({ runId, variant, distance: store.distanceMeters, referenceDistance: reference.normalized.distanceM, geometry: comparison });
}

setActivePinia(createPinia());
const store = useRouteStore();
store.resetRoute([[15.4325, 47.0757], [15.416, 47.083], [15.406859, 47.077267], [15.404583, 47.066835], [15.404496, 47.064171]]);
await idle(store);
const durations = [];
for (let i = 0; i < 12; i++) {
  const unchanged = [Object.values(store.legs)[0], Object.values(store.legs)[3]];
  const before = requestCount, start = performance.now();
  store.updateWaypointCoord(store.waypoints[2].id, i % 2 ? [15.406859, 47.077267] : [15.404995, 47.077212]);
  await idle(store);
  durations.push(performance.now() - start);
  assert.equal(requestCount - before, 3);
  assert.equal(Object.values(store.legs)[0], unchanged[0]);
  assert.equal(Object.values(store.legs)[3], unchanged[1]);
}
durations.sort((a, b) => a - b);
const coordinates = Array.from({ length: 10000 }, (_, i) => [15.4 + i / 100000, 47]);
const synthetic = { features: [{ geometry: { coordinates }, properties: { legId: 'long', fromId: 'a', toId: 'b', status: 'routed', surfaces: [{ fromIndex: 0, toIndex: 9999, surface: 'asphalt' }] } }] };
const renderTimes = [];
for (let i = 0; i < 200; i++) {
  const start = performance.now();
  assert.equal(getSegments(synthetic).length, 1);
  renderTimes.push(performance.now() - start);
}
renderTimes.sort((a, b) => a - b);
const report = { comparisons, localEdit: { samples: 12, requestsPerEdit: 3, medianMs: durations[6], p95Ms: durations[11] },
  syntheticConversion: { vertices: 10000, features: 1, medianMs: renderTimes[100], p95Ms: renderTimes[190], note: 'GeoJSON preparation only; not browser frame time or a before/after speedup.' } };
await fs.writeFile('experiments/routing/.local/editor-local-check.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

// Requires the existing regional BRouter data; optional URL targets a staging instance.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const endpoint = new URL('/brouter', process.argv[2] ?? 'http://127.0.0.1:17777');
endpoint.search = new URLSearchParams({
  profile: 'richi-local-v1', lonlats: '15.521873,47.095702|15.503735,47.105271',
  format: 'geojson', 'profile:considerTurnRestrictions': '1',
}).toString();
const response = await fetch(endpoint, { signal: AbortSignal.timeout(70000) });
assert.equal(response.status, 200);
const raw = await response.json();
const route = raw.features.find(feature => feature.geometry.type === 'LineString');
const coordinates = route.geometry.coordinates;
assert.equal(Number(route.properties['track-length']), 4898);
assert.ok(coordinates.some(([lon, lat]) => lon === 15.539841 && lat === 47.103009), 'Uses reported junction');
assert.ok(Math.max(...coordinates.map(point => point[0])) < 15.5401, 'Does not overshoot to the service-road turnaround');
const report = {
  patch: 'ries-bicycle-turn-v1', request: endpoint.href, distanceM: 4898,
  previousDistanceM: 5158, removedDetourM: 260, turnRestrictionsEnabled: true,
};
await fs.writeFile('experiments/routing/.local/ries-junction-corrected.json', JSON.stringify({ ...report, raw }, null, 2));
console.log(JSON.stringify(report, null, 2));

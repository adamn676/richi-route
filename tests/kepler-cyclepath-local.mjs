import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { distanceM, route } from '../experiments/routing/engines.mjs';

// Rider instruction: always use the cycle path on Keplerstrasse.
// This checks the eastern 720 m section, not Lendkai or the entire street.
const endpoints = [[15.423837, 47.074389], [15.432345, 47.076993]];
const checkpoints = [[15.425417, 47.074850], [15.428538, 47.075746], [15.430821, 47.076619]];
const settings = 'local-rules-v1';
const report = { createdAt: new Date().toISOString(), settings, results: [] };

for (const direction of ['east', 'west']) {
  const ordered = direction === 'east' ? endpoints : endpoints.toReversed();
  const points = ordered.map(coord => ({ role: 'stop', coord }));
  const result = await route('brouter', points, fetch, settings);
  assert.equal(result.status, 'ok', result.error);
  const raw = JSON.parse(result.rawText);
  const feature = raw.features.find(f => f.geometry?.type === 'LineString');
  const coordinates = feature.geometry.coordinates;
  const distance = Number(feature.properties['track-length']);
  assert.ok(distanceM(coordinates[0], ordered[0]) < 2, `${direction}: start retained`);
  assert.ok(distanceM(coordinates.at(-1), ordered[1]) < 2, `${direction}: destination retained`);
  assert.ok(distance >= 700 && distance <= 740, `${direction}: no shortcut or detour (${distance} m)`);

  // Checkpoints are assertions only; the router receives just the two endpoints.
  let previousIndex = -1;
  for (const checkpoint of direction === 'east' ? checkpoints : checkpoints.toReversed()) {
    const index = coordinates.findIndex((coord, i) => i > previousIndex && distanceM(coord, checkpoint) < 2);
    assert.ok(index >= 0, `${direction}: follows the cycle path in order`);
    previousIndex = index;
  }
  const [header, ...messages] = feature.properties.messages;
  assert.ok(messages.length > 0, `${direction}: road details available`);
  const tagsIndex = header.indexOf('WayTags');
  assert.ok(tagsIndex >= 0);
  for (const message of messages) {
    assert.match(message[tagsIndex], /(?:^|\s)highway=cycleway(?:\s|$)/, `${direction}: stays on cycleways, including crossings`);
  }
  report.results.push({ direction, request: result.request, distanceM: distance, raw });
  console.log(`Keplerstrasse ${direction}: ${distance} m, cycle path throughout, no intermediate waypoints.`);
}

const file = new URL(`../experiments/routing/.local/kepler-check-${report.createdAt.replaceAll(/[:.]/g, '-')}.json`, import.meta.url);
await writeFile(file, JSON.stringify(report, null, 2) + '\n');
console.log(`Saved ${file.pathname}`);

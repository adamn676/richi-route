import { createWriteStream } from 'node:fs';
import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inRoutingArea } from '../../scripts/offline/geometry.mjs';
import { filePositions, roadRides, simplify } from './rides.mjs';

// The road rides of the Strava archive extracted to .cache/strava/export (activities.csv and activities/), as compact
// tracks in .cache/strava/rides.ndjson: one ride per line, rides that leave the routing data's rectangle left out.
// The rides stay on this computer; nothing of them goes into git.
const strava = fileURLToPath(new URL('../../.cache/strava/', import.meta.url));
const rides = roadRides(await readFile(path.join(strava, 'export/activities.csv'), 'utf8'));
const output = createWriteStream(path.join(strava, 'rides.ndjson.part'));
const skipped = { outside: 0, short: 0, unreadable: 0 };
let kept = 0;
for (const ride of rides) {
  let positions;
  try { positions = filePositions(ride.file, await readFile(path.join(strava, 'export', ride.file))); } catch { skipped.unreadable++; continue; }
  if (positions.length < 10) { skipped.short++; continue; }
  if (!positions.every(inRoutingArea)) { skipped.outside++; continue; }
  const points = simplify(positions).map(([lon, lat]) => [+lon.toFixed(6), +lat.toFixed(6)]);
  if (!output.write(`${JSON.stringify({ id: ride.id, date: ride.date, gear: ride.gear, points })}\n`)) await new Promise(resolve => output.once('drain', resolve));
  kept++;
}
await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()));
await rename(path.join(strava, 'rides.ndjson.part'), path.join(strava, 'rides.ndjson'));
console.log(`${kept} of ${rides.length} road rides kept; left out: ${skipped.outside} beyond the routing data, ${skipped.short} without a track, ${skipped.unreadable} unreadable.`);

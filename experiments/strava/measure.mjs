import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { routingParameters, routingPolicyVersion, routingProfile } from '../../src/config/routing-policy.ts';
import { heldOut, legMeters, legs, shareOn } from './compare.mjs';

// How closely the planner's routes follow the rider's own: every leg of every road ride (.cache/strava/rides.ndjson,
// from extract-rides.mjs) is routed from its start to its end, as the planner asks, with the local rules and surface
// corrections, and compared with the road ridden. Results go to .cache/strava/runs/<name>/: each leg, and a summary for
// the training rides and the rides kept out.
//   node experiments/strava/measure.mjs [--name baseline] [--rides 20] [--threads 6]
const { values: options } = parseArgs({ options: { name: { type: 'string', default: 'baseline' }, rides: { type: 'string' },
  threads: { type: 'string', default: '6' } } });
const root = fileURLToPath(new URL('../../', import.meta.url));
const strava = path.join(root, '.cache/strava');
const rules = path.join(root, 'experiments/routing/.local/local-routing-rules');
const output = path.join(strava, 'runs', options.name);
await mkdir(output, { recursive: true });

const engine = spawn(path.join(root, 'engine/target/release/richi-engine'),
  ['lines', path.join(root, '../richiroute-ubuntu-benchmark/data'), path.join(rules, 'profiles'), options.threads, '256'],
  { env: { ...process.env, RICHIROUTE_RULES: path.join(rules, 'rules.tsv'), RICHIROUTE_SURFACES: path.join(rules, 'surfaces.tsv') },
    stdio: ['pipe', 'pipe', 'inherit'] });
const engineEnded = new Promise((resolve, reject) => engine.once('exit', code => code ? reject(new Error(`Engine ended with ${code}`)) : resolve()));
const query = ([from, to]) => {
  const params = new URLSearchParams({ profile: routingProfile, lonlats: `${from.join(',')}|${to.join(',')}`, format: 'geojson', alternativeidx: '0' });
  for (const [name, value] of Object.entries(routingParameters)) params.set(`profile:${name}`, String(value));
  return params;
};

// Legs waiting for their route; a few dozen at a time, so the engine always has work and memory stays small.
const waiting = new Map(), window = 48;
let slot;
const results = createWriteStream(path.join(output, 'legs.ndjson'));
const totals = { training: newTotal(), heldOut: newTotal() };
function newTotal() { return { rides: new Set(), legs: 0, failed: 0, ridden: 0, routed: 0, routeOnRide: 0, rideOnRoute: 0, close: 0 }; }

readline.createInterface({ input: engine.stdout }).on('line', line => {
  const answer = JSON.parse(line), leg = waiting.get(answer.id);
  waiting.delete(answer.id);
  const total = totals[leg.heldOut ? 'heldOut' : 'training'];
  total.rides.add(leg.ride);
  total.legs++;
  // The engine answers with the GeoJSON as text, as the planner's server sends it.
  const coordinates = answer.geojson && JSON.parse(answer.geojson).features[0]?.geometry.coordinates.map(([lon, lat]) => [lon, lat]);
  let result = { id: answer.id, heldOut: leg.heldOut, ms: answer.ms };
  if (!coordinates?.length) {
    total.failed++;
    result.error = answer.error ?? 'no route';
  } else {
    const route = shareOn(coordinates, leg.points), ride = shareOn(leg.points, coordinates);
    total.ridden += ride.meters;
    total.routed += route.meters;
    total.routeOnRide += route.share * route.meters;
    total.rideOnRoute += ride.share * ride.meters;
    if (route.share >= .9 && ride.share >= .9) total.close++;
    result = { ...result, ridden: Math.round(ride.meters), routed: Math.round(route.meters),
      routeOnRide: +route.share.toFixed(3), rideOnRoute: +ride.share.toFixed(3) };
  }
  results.write(`${JSON.stringify(result)}\n`);
  slot?.();
});

let rideCount = 0;
for await (const line of readline.createInterface({ input: createReadStream(path.join(strava, 'rides.ndjson')) })) {
  if (options.rides && rideCount >= Number(options.rides)) break;
  const ride = JSON.parse(line);
  rideCount++;
  for (const [index, points] of legs(ride.points).entries()) {
    while (waiting.size >= window) await new Promise(resolve => { slot = resolve; });
    const id = `${ride.id}/${index}`;
    waiting.set(id, { ride: ride.id, points, heldOut: heldOut(ride.id) });
    engine.stdin.write(`${id}\t${query([points[0], points.at(-1)])}\n`);
  }
}
engine.stdin.end();
await engineEnded;
await new Promise(resolve => results.end(resolve));

const share = (part, whole) => whole ? +(part / whole).toFixed(3) : null;
const summary = { name: options.name, measured: new Date().toISOString(), rules: routingPolicyVersion, legMeters,
  ...Object.fromEntries(Object.entries(totals).map(([key, total]) => [key, {
    rides: total.rides.size, legs: total.legs, failed: total.failed, riddenKm: Math.round(total.ridden / 1000),
    // Of the routes' length, the share on roads the rider took; of the rides' length, the share the routes took.
    routeOnRide: share(total.routeOnRide, total.routed), rideOnRoute: share(total.rideOnRoute, total.ridden),
    // Legs where both lie at least 90 % on each other.
    closeLegs: share(total.close, total.legs - total.failed),
  }])) };
await writeFile(path.join(output, 'summary.json.part'), `${JSON.stringify(summary, null, 2)}\n`);
await rename(path.join(output, 'summary.json.part'), path.join(output, 'summary.json'));
console.log(JSON.stringify(summary, null, 2));

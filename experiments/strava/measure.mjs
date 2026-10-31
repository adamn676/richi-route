import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { routingPolicyVersion } from '../../src/config/routing-policy.ts';
import { familiarity, group, inOsttirol, legMeters, legs, sections, shareOn } from './compare.mjs';
import { slots, startEngine, strava } from './engine.mjs';

// How closely the planner's routes follow the rider's own: every leg of the measured rides (.cache/strava/rides.ndjson,
// from extract-rides.mjs) is routed from its start to its end, as the planner asks, and compared with the road ridden.
// Results go to .cache/strava/runs/<name>/: each leg, a summary, and with --routes the planner's road sections per leg.
//   node experiments/strava/measure.mjs [--name baseline] [--groups 0] [--preferences file] [--routes]
const { values: options } = parseArgs({ options: { name: { type: 'string', default: 'baseline' }, groups: { type: 'string', default: '0,1,2,3,4' },
  preferences: { type: 'string' }, routes: { type: 'boolean' }, threads: { type: 'string', default: '6' } } });
const measured = new Set(options.groups.split(',').map(Number));
const output = path.join(strava, 'runs', options.name);
await mkdir(output, { recursive: true });

// The rides the tracing kept as ridden on roads (trace-rides.mjs).
const onRoads = new Set();
for await (const line of readline.createInterface({ input: createReadStream(path.join(strava, 'ridden.ndjson')) })) onRoads.add(JSON.parse(line).id);
const rides = [];
for await (const line of readline.createInterface({ input: createReadStream(path.join(strava, 'rides.ndjson')) })) {
  const ride = JSON.parse(line);
  if (onRoads.has(ride.id)) rides.push(ride);
}
// How familiar an area is: the rides there that are not measured.
const familiar = familiarity(rides.filter(ride => !measured.has(group(ride.id))).map(ride => ride.points));
// Areas with fewer rides than this count as rarely ridden.
const often = 10;

const engine = startEngine({ threads: Number(options.threads), preferences: options.preferences });
const results = createWriteStream(path.join(output, 'legs.ndjson'));
const routes = options.routes && createWriteStream(path.join(output, 'routes.ndjson'));
const kinds = ['all', 'firstLegs', 'osttirol', 'oftenRidden', 'rarelyRidden'];
const totals = Object.fromEntries(kinds.map(kind => [kind, { legs: 0, failed: 0, ridden: 0, routed: 0, routeOnRide: 0, rideOnRoute: 0, close: 0 }]));
const work = slots(48);
for (const ride of rides.filter(ride => measured.has(group(ride.id)))) {
  for (const [index, points] of legs(ride.points).entries()) {
    const id = `${ride.id}/${index}`;
    const leg = { id, first: index === 0, osttirol: inOsttirol(points[0]), passes: familiar(points) };
    await work.run(async () => {
      const answer = await engine.route([points[0], points.at(-1)]);
      const kindsOf = ['all', ...leg.first ? ['firstLegs'] : [], ...leg.osttirol ? ['osttirol'] : [], leg.passes >= often ? 'oftenRidden' : 'rarelyRidden'];
      let result = { ...leg, ms: answer.ms };
      if (answer.error) {
        result.error = answer.error;
        for (const kind of kindsOf) { totals[kind].legs++; totals[kind].failed++; }
      } else {
        const route = shareOn(answer.coordinates, [points]), ridden = shareOn(points, [answer.coordinates]);
        for (const kind of kindsOf) {
          const total = totals[kind];
          total.legs++;
          total.ridden += ridden.meters;
          total.routed += route.meters;
          total.routeOnRide += route.share * route.meters;
          total.rideOnRoute += ridden.share * ridden.meters;
          if (route.share >= .9 && ridden.share >= .9) total.close++;
        }
        result = { ...result, ridden: Math.round(ridden.meters), routed: Math.round(route.meters),
          routeOnRide: +route.share.toFixed(3), rideOnRoute: +ridden.share.toFixed(3) };
        if (routes) routes.write(`${JSON.stringify({ id, sections: sections(answer.coordinates) })}\n`);
      }
      results.write(`${JSON.stringify(result)}\n`);
    });
  }
}
await work.all();
await engine.close();
await Promise.all([results, routes].filter(Boolean).map(stream => new Promise(resolve => stream.end(resolve))));

const share = (part, whole) => whole ? +(part / whole).toFixed(3) : null;
const summary = { name: options.name, measured: new Date().toISOString(), rules: routingPolicyVersion, preferences: options.preferences ?? null,
  groups: [...measured], legMeters, often,
  ...Object.fromEntries(Object.entries(totals).map(([kind, total]) => [kind, {
    legs: total.legs, failed: total.failed, riddenKm: Math.round(total.ridden / 1000),
    // Of the routes' length, the share on roads the rider took; of the rides' length, the share the routes took.
    routeOnRide: share(total.routeOnRide, total.routed), rideOnRoute: share(total.rideOnRoute, total.ridden),
    // Legs where both lie at least 90 % on each other.
    closeLegs: share(total.close, total.legs - total.failed),
  }])) };
await writeFile(path.join(output, 'summary.json.part'), `${JSON.stringify(summary, null, 2)}\n`);
await rename(path.join(output, 'summary.json.part'), path.join(output, 'summary.json'));
console.log(JSON.stringify(summary, null, 2));

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { group } from './compare.mjs';
import { strava } from './engine.mjs';

// The rider's road preferences, learned from the choices on their rides: a road section came up on a ride when the
// rider took it (.cache/strava/ridden.ndjson) or the planner offered it for one of the ride's legs (routes.ndjson of a
// measure.mjs --routes run without preferences). Its choice share is how often it was taken when it came up, however
// seldom that was; it scales the section's cost from 1 − bonus (always taken) to 1 + penalty (never taken). Unpaved
// roads and those of unknown surface are never counted as taken.
// The defaults learn from all rides with the strengths that matched held-out rides best (2026-10-31: bonus 0.5, no
// penalty), into .cache/strava/preferences/rider.tsv, which the local planner's engine reads.
//   node experiments/strava/learn.mjs [--groups 2,3,4] [--offered offered] [--bonus 0.5] [--penalty 0] [--name rider]
const { values: options } = parseArgs({ options: { groups: { type: 'string', default: '0,1,2,3,4' }, offered: { type: 'string', default: 'offered' },
  bonus: { type: 'string', default: '0.5' }, penalty: { type: 'string', default: '0' }, name: { type: 'string', default: 'rider' } } });
const learned = new Set(options.groups.split(',').map(Number));
const [bonus, penalty] = [Number(options.bonus), Number(options.penalty)];
const lines = file => readline.createInterface({ input: createReadStream(file) });

const offered = new Map();
for await (const line of lines(path.join(strava, 'runs', options.offered, 'routes.ndjson'))) {
  const { id, sections } = JSON.parse(line), ride = id.split('/')[0];
  if (!learned.has(group(ride))) continue;
  if (!offered.has(ride)) offered.set(ride, new Set());
  for (const section of sections) offered.get(ride).add(section);
}
const came = new Map(), taken = new Map();
for await (const line of lines(path.join(strava, 'ridden.ndjson'))) {
  const { id, sections, unpaved } = JSON.parse(line);
  if (!learned.has(group(id))) continue;
  for (const section of new Set([...sections, ...offered.get(id) ?? []])) came.set(section, (came.get(section) ?? 0) + 1);
  // Riding an unpaved road (or one of unknown surface) never makes it the rider's choice.
  const dirt = new Set(unpaved);
  for (const section of sections) if (!dirt.has(section)) taken.set(section, (taken.get(section) ?? 0) + 1);
}

await mkdir(path.join(strava, 'preferences'), { recursive: true });
const file = path.join(strava, 'preferences', `${options.name}.tsv`);
const output = createWriteStream(`${file}.part`);
output.write('richiroute-preferences\t1\n');
for (const [section, times] of came) {
  const factor = 1 + penalty - (bonus + penalty) * (taken.get(section) ?? 0) / times;
  if (factor !== 1 && !output.write(`${section.replaceAll(',', '\t')}\t${Math.min(10, Math.max(.1, factor)).toFixed(3)}\n`)) {
    await new Promise(resolve => output.once('drain', resolve));
  }
}
await new Promise(resolve => output.end(resolve));
await rename(`${file}.part`, file);
console.log(`${came.size} sections from ${[...learned]} → ${file}`);

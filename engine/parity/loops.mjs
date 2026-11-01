// Records the planner's loop suggestions for 20 starts through its own client code (suggestLoops) and the routing
// server's /loops (engine/planner), and compares recordings: each pick's leg exactly (coordinates, heights, surfaces,
// distance, climbing), heading, squares, whether it rides out and back, and the points looked up to name the picks.
//   node parity/loops.mjs planner            record with richi-engine serve (as `planner`)
//   node parity/loops.mjs planner --dice     each start with its own fixed dice instead of all 0
//   node parity/loops.mjs planner --as name  record under another name
//   node parity/loops.mjs compare a b
// Run from app/engine/. The server runs with the local rules (RICHIROUTE_RULES, default the prepared rule file) on
// 127.0.0.1:RICHIROUTE_LOOPS_PORT (default 17796) with the planner's concurrency as its thread count unless
// RICHIROUTE_ENGINE_THREADS says otherwise. Paths: RICHIROUTE_SEGMENTS, RICHIROUTE_PROFILES; the engine is built
// into CARGO_TARGET_DIR (default target/). Recordings before the loops moved into the engine (java.json, rust.json:
// the TypeScript asking an engine process for each round trip) also hold every engine answer; compare checks those
// where both recordings have them.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { suggestLoops } from '../../src/services/loop-suggestions.service.ts';
import { routingConcurrency } from '../../src/domain/route-model.ts';

const engineDir = fileURLToPath(new URL('../', import.meta.url));
const app = path.join(engineDir, '..');
const segments = process.env.RICHIROUTE_SEGMENTS ?? path.join(app, '../richiroute-ubuntu-benchmark/data');
const rulesDir = path.join(app, 'experiments/routing/.local/local-routing-rules');
const profiles = process.env.RICHIROUTE_PROFILES ?? path.join(rulesDir, 'profiles');
const rules = process.env.RICHIROUTE_RULES ?? path.join(rulesDir, 'rules.tsv');
const port = Number(process.env.RICHIROUTE_LOOPS_PORT ?? 17796);
const output = path.join(engineDir, 'target/parity/loops');
const engineThreads = process.env.RICHIROUTE_ENGINE_THREADS ?? String(routingConcurrency);

// Starts across the routing data (10–20° E, 45–50° N): towns, hills and Alpine valleys.
const starts = [
  ['Graz', 15.4395, 47.0707], ['Wien', 16.3725, 48.2085], ['Linz', 14.2858, 48.3069], ['Salzburg', 13.055, 47.8095],
  ['Innsbruck', 11.3933, 47.2692], ['Klagenfurt', 14.3055, 46.6247], ['St. Pölten', 15.6256, 48.2047],
  ['Bad Ischl', 13.6206, 47.7115], ['Leoben', 15.097, 47.3765], ['Villach', 13.8558, 46.6111],
  ['Ljubljana', 14.5058, 46.0569], ['Bratislava', 17.1077, 48.1486], ['München', 11.5755, 48.1374],
  ['Brno', 16.6068, 49.1951], ['Sopron', 16.5853, 47.6817], ['Maribor', 15.6459, 46.5547], ['Bozen', 11.3548, 46.4983],
  ['Udine', 13.2349, 46.0711], ['České Budějovice', 14.4747, 48.9745], ['Feldbach', 15.8883, 46.9531],
];
const cases = starts.map(([name, lon, lat], i) => {
  const km = [30, 60, 100][i % 3];
  return { name, start: [lon, lat], target: { meters: km * 1000, ascent: km * 10 } };
});

const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
// With --dice, each start gets its own fixed dice (turn and shapes); otherwise every throw is 0.
const throwDice = process.argv.includes('--dice');
function dice(seed) {
  if (!throwDice) return () => 0;
  let state = seed + 1;
  return () => { state = (state * 48271) % 2147483647; return state / 2147483647; };
}
// Everything of a suggestion but its name: the leg exactly, its heading, squares and whether it rides out and back.
const pickRecord = ({ leg, heading, cells, back }) => ({ heading, back, km: +(leg.distanceMeters / 1000).toFixed(2),
  distanceMeters: leg.distanceMeters, ascentMeters: leg.ascentMeters, coordinates: sha(JSON.stringify(leg.coordinates)),
  elevations: sha(JSON.stringify(leg.elevations)), cells: sha(JSON.stringify(cells)),
  surfaces: sha(JSON.stringify(leg.surfaces.map(({ fromIndex, toIndex, surface, surfaceTag, osm }) =>
    ({ fromIndex, toIndex, surface, surfaceTag, osm: osm && { surface: osm.surface, surfaceTag: osm.surfaceTag } })))) });

async function record(name) {
  const release = path.join(process.env.CARGO_TARGET_DIR ?? path.join(engineDir, 'target'), 'release');
  const server = spawn(path.join(release, 'richi-engine'), ['serve', segments, profiles, String(port), engineThreads],
    { env: { ...process.env, RICHIROUTE_RULES: rules }, stdio: ['ignore', 'ignore', 'inherit'] });
  const stopped = new Promise(resolve => server.on('close', resolve));
  try {
    const origin = `http://127.0.0.1:${port}`;
    for (let ready = false; !ready;) {
      ready = await fetch(origin).then(() => true, () => false);
      if (server.exitCode !== null) throw new Error(`richi-engine serve stopped (exit code ${server.exitCode})`);
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    // The planner's route service asks '/routing/loops'; the server answers it directly.
    const reach = globalThis.fetch;
    globalThis.fetch = (url, init) => reach(String(url).replace(/^\/routing/, origin), init);
    // Warm up (caches) with one loop set that is not recorded.
    await suggestLoops(cases[0].start, cases[0].target, new AbortController().signal, { town: async () => undefined, random: () => 0 });
    const results = [];
    for (const [i, { name, start, target }] of cases.entries()) {
      const looked = [], town = async coord => { looked.push(coord); return undefined; };
      const began = performance.now();
      let picks, failure;
      try { picks = await suggestLoops(start, target, new AbortController().signal, { town, random: dice(i) }); }
      catch (error) { failure = String(error?.message ?? error); }
      const ms = Math.round(performance.now() - began);
      results.push({ name, start, target, ms, failure, picks: picks?.map(pickRecord), lookups: sha(JSON.stringify(looked)) });
      console.log(`${name.padEnd(18)} ${String(ms).padStart(6)} ms  ${failure ?? picks.map(pick => `${pick.heading} ${(pick.leg.distanceMeters / 1000).toFixed(1)} km`).join(', ')}`);
    }
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, `${name}.json`), JSON.stringify(results, null, 1));
    const total = results.reduce((sum, result) => sum + result.ms, 0);
    console.log(`${name}: ${results.length} starts, ${(total / results.length / 1000).toFixed(2)} s per start on average`);
  } finally {
    server.kill();
    await stopped;
  }
}

async function compare(a, b) {
  const [left, right] = await Promise.all([a, b].map(async engine => JSON.parse(await readFile(path.join(output, `${engine}.json`), 'utf8'))));
  let answers = 0, differentAnswers = 0, differentPicks = 0;
  for (let i = 0; i < left.length; i++) {
    const [l, r] = [left[i], right[i]];
    if (l.answers && r.answers) {
      const rights = new Map(r.answers.map(answer => [answer.query, answer.result]));
      for (const answer of l.answers) {
        answers++;
        if (rights.get(answer.query) !== answer.result) {
          differentAnswers++;
          if (differentAnswers <= 10) console.log(`different answer: ${l.name} ${answer.query}`);
        }
      }
    }
    if (JSON.stringify(l.picks) !== JSON.stringify(r.picks) || l.failure !== r.failure || l.lookups !== r.lookups) {
      differentPicks++;
      console.log(`different suggestions: ${l.name}\n  ${a}: ${JSON.stringify(l.picks ?? l.failure)}\n  ${b}: ${JSON.stringify(r.picks ?? r.failure)}`);
    }
  }
  const speed = engine => (engine.reduce((sum, result) => sum + result.ms, 0) / engine.length / 1000).toFixed(2);
  if (answers) console.log(`${answers} round trips, ${differentAnswers} different`);
  console.log(`${left.length} starts, ${left.reduce((n, l) => n + (l.picks?.length ?? 0), 0)} picks, ${differentPicks} starts with different suggestions`);
  console.log(`time per start: ${a} ${speed(left)} s, ${b} ${speed(right)} s`);
  process.exitCode = differentAnswers || differentPicks ? 1 : 0;
}

const [mode, ...rest] = process.argv.slice(2).filter(arg => arg !== '--dice');
if (mode === 'compare') await compare(rest[0], rest[1]);
else if (mode === 'planner') await record(rest[0] === '--as' ? rest[1] : 'planner');
else throw new Error('Usage: node parity/loops.mjs planner [--dice] [--as name] | compare a b');

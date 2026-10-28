// Runs the planner's own loop suggestions (36 round trips per start) against a routing engine process and
// records every answer and the three picks. The engine speaks RouteReference's line protocol: "id<TAB>query"
// in, one JSON line {"id","ms","error"|"geojson"} out.
//   node parity/loops.mjs java          record with the Java reference (BRouter 1.7.10)
//   node parity/loops.mjs rust          record with the Rust engine
//   node parity/loops.mjs compare java rust
//   node parity/loops.mjs java --as java-now   record under another name (e.g. to time Java again
//                                              without replacing the baseline), compare with that name
// Run from app/engine/. Paths: RICHIROUTE_SEGMENTS, RICHIROUTE_PROFILES, RICHIROUTE_JAVA, RICHIROUTE_BROUTER_JAR;
// the Rust engine is built into CARGO_TARGET_DIR (default target/). The engine runs with the planner's
// concurrency as its thread count unless RICHIROUTE_ENGINE_THREADS says otherwise; the planner still sends
// that many requests at a time.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { suggestLoops } from '../../src/services/loop-suggestions.service.ts';
import { routingConcurrency } from '../../src/domain/route-model.ts';

const engineDir = fileURLToPath(new URL('../', import.meta.url));
const app = path.join(engineDir, '..');
const segments = process.env.RICHIROUTE_SEGMENTS ?? path.join(app, '../richiroute-ubuntu-benchmark/data');
const profiles = process.env.RICHIROUTE_PROFILES ?? path.join(app, 'experiments/routing/.local/local-routing-rules/profiles');
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

function engineCommand(engine) {
  if (engine === 'java') {
    const java = process.env.RICHIROUTE_JAVA ?? path.join(app, '.cache/runtime/java/bin/java');
    const jar = process.env.RICHIROUTE_BROUTER_JAR ?? path.join(app, '../richiroute-ubuntu-benchmark/brouter.jar');
    const classes = path.join(engineDir, 'target/parity/classes');
    const classpath = [path.join(classes, 'pristine'), jar, path.join(classes, 'router')].join(path.delimiter);
    return [java, ['-Xmx1g', '-cp', classpath, 'RouteReference', segments, profiles, engineThreads]];
  }
  const release = path.join(process.env.CARGO_TARGET_DIR ?? path.join(engineDir, 'target'), 'release');
  if (engine === 'rust') return [path.join(release, 'richi-engine'), ['lines', segments, profiles, engineThreads]];
  throw new Error(`Unknown engine ${engine}`);
}

const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

async function record(engine, name = engine) {
  const [command, args] = engineCommand(engine);
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  child.on('close', (code, signal) => {
    if (pending.size) {
      console.error(`${engine} stopped (${signal ?? `exit code ${code}`}) with ${pending.size} requests unanswered`);
      process.exit(1);
    }
  });
  createInterface({ input: child.stdout }).on('line', line => {
    const answer = JSON.parse(line);
    pending.get(answer.id)(answer);
    pending.delete(answer.id);
  });
  let nextId = 0, answers = [];
  // The planner's route service calls fetch('/routing/brouter?…'); answer it from the engine instead.
  globalThis.fetch = async url => {
    const query = String(url).slice(String(url).indexOf('?') + 1);
    const id = String(nextId++);
    const answer = await new Promise(resolve => { pending.set(id, resolve); child.stdin.write(`${id}\t${query}\n`); });
    answers.push({ query, ms: answer.ms, result: sha(answer.geojson ?? `error: ${answer.error}`), error: answer.error });
    return answer.error ? new Response(answer.error, { status: 400 }) : new Response(answer.geojson, { status: 200 });
  };
  // Warm up (JIT, caches) with one loop set that is not recorded.
  await suggestLoops(cases[0].start, cases[0].target, new AbortController().signal, undefined, async () => undefined);
  const results = [];
  for (const { name, start, target } of cases) {
    answers = [];
    const began = performance.now();
    let picks, failure;
    try { picks = await suggestLoops(start, target, new AbortController().signal, undefined, async () => undefined); }
    catch (error) { failure = String(error?.message ?? error); }
    const ms = Math.round(performance.now() - began);
    answers.sort((a, b) => a.query.localeCompare(b.query));
    results.push({ name, start, target, ms, failure, answers,
      picks: picks?.map(({ leg, heading }) => ({ heading, km: +(leg.distanceMeters / 1000).toFixed(2), ascent: leg.ascentMeters,
        coordinates: sha(JSON.stringify(leg.coordinates)) })) });
    console.log(`${name.padEnd(18)} ${String(ms).padStart(6)} ms  ${failure ?? picks.map(pick => `${pick.heading} ${(pick.leg.distanceMeters / 1000).toFixed(1)} km`).join(', ')}`);
  }
  child.stdin.end();
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, `${name}.json`), JSON.stringify(results, null, 1));
  const total = results.reduce((sum, result) => sum + result.ms, 0);
  console.log(`${engine}: ${results.length} starts, ${results.reduce((n, r) => n + r.answers.length, 0)} round trips, ` +
    `${(total / results.length / 1000).toFixed(2)} s per start on average`);
}

async function compare(a, b) {
  const [left, right] = await Promise.all([a, b].map(async engine => JSON.parse(await readFile(path.join(output, `${engine}.json`), 'utf8'))));
  let answers = 0, differentAnswers = 0, differentPicks = 0;
  for (let i = 0; i < left.length; i++) {
    const [l, r] = [left[i], right[i]];
    const rights = new Map(r.answers.map(answer => [answer.query, answer.result]));
    for (const answer of l.answers) {
      answers++;
      if (rights.get(answer.query) !== answer.result) {
        differentAnswers++;
        if (differentAnswers <= 10) console.log(`different answer: ${l.name} ${answer.query}`);
      }
    }
    if (JSON.stringify(l.picks) !== JSON.stringify(r.picks) || l.failure !== r.failure) {
      differentPicks++;
      console.log(`different suggestions: ${l.name}\n  ${a}: ${JSON.stringify(l.picks ?? l.failure)}\n  ${b}: ${JSON.stringify(r.picks ?? r.failure)}`);
    }
  }
  const speed = engine => (engine.reduce((sum, result) => sum + result.ms, 0) / engine.length / 1000).toFixed(2);
  console.log(`${answers} round trips, ${differentAnswers} different; ${left.length} starts, ${differentPicks} with different suggestions`);
  console.log(`time per start: ${a} ${speed(left)} s, ${b} ${speed(right)} s`);
  process.exitCode = differentAnswers || differentPicks ? 1 : 0;
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'compare') await compare(rest[0] ?? 'java', rest[1] ?? 'rust');
else await record(mode ?? 'java', rest[0] === '--as' ? rest[1] : undefined);

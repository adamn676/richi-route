import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { routingParameters, routingProfile } from '../../src/config/routing-policy.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const strava = path.join(root, '.cache/strava');
const rules = path.join(root, 'experiments/routing/.local/local-routing-rules');

// The routing engine without a port (`richi-engine legs`), with the planner's profile, local rules and surface
// corrections, and the rider's road `preferences` file if given. `route` asks as the planner does (`extra` as its round
// trips) and answers with the route as the planner reads it ([lon, lat] points, surfaces), or an error.
export function startEngine({ threads = 6, preferences } = {}) {
  const env = { ...process.env, RICHIROUTE_RULES: path.join(rules, 'rules.tsv'), RICHIROUTE_SURFACES: path.join(rules, 'surfaces.tsv') };
  // Only the preferences asked for, never ones the shell happens to have.
  delete env.RICHIROUTE_PREFERENCES;
  if (preferences) env.RICHIROUTE_PREFERENCES = preferences;
  const engine = spawn(path.join(root, 'engine/target/release/richi-engine'),
    ['legs', path.join(root, '../richiroute-ubuntu-benchmark/data'), path.join(rules, 'profiles'), String(threads), '256'],
    { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const ended = new Promise((resolve, reject) => engine.once('exit', code => code ? reject(new Error(`Engine ended with ${code}`)) : resolve()));
  const waiting = new Map();
  let next = 0;
  readline.createInterface({ input: engine.stdout }).on('line', line => {
    const answer = JSON.parse(line), resolve = waiting.get(answer.id);
    waiting.delete(answer.id);
    const { leg } = answer;
    resolve(leg ? { coordinates: leg.coordinates, surfaces: leg.surfaces, ms: answer.ms } : { error: answer.error ?? 'no route', ms: answer.ms });
  });
  return {
    route(points, extra = {}) {
      const params = new URLSearchParams({ profile: routingProfile, lonlats: points.map(point => point.join(',')).join('|'), format: 'geojson', alternativeidx: '0', ...extra });
      for (const [name, value] of Object.entries(routingParameters)) params.set(`profile:${name}`, String(value));
      const id = String(next++);
      return new Promise(resolve => { waiting.set(id, resolve); engine.stdin.write(`${id}\t${params}\n`); });
    },
    close: () => { engine.stdin.end(); return ended; },
  };
}

// Runs `task`s with at most `count` at a time: `run` waits for a free slot, then starts the task.
export function slots(count) {
  const running = new Set();
  return {
    async run(task) {
      while (running.size >= count) await Promise.race(running);
      const promise = task().finally(() => running.delete(promise));
      running.add(promise);
    },
    all: () => Promise.all(running),
  };
}

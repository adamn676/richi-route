// Query set and comparison for parity/route.sh.
//   node parity/route.mjs queries <routing-rules.json> <routing-search.json>    prints "id<TAB>query" lines
//   node parity/route.mjs compare <queries> <java.jsonl> <rust.jsonl>
// Queries are built like the planner's route service builds them (app/src/services/route.service.ts).
import { readFileSync } from 'node:fs';

const starts = {
  graz: [15.4395, 47.0707], wien: [16.3725, 48.2085], linz: [14.2858, 48.3069], salzburg: [13.055, 47.8095],
  innsbruck: [11.3933, 47.2692], klagenfurt: [14.3055, 46.6247], ljubljana: [14.5058, 46.0569],
  bratislava: [17.1077, 48.1486], muenchen: [11.5755, 48.1374], brno: [16.6068, 49.1951], bozen: [11.3548, 46.4983],
  leoben: [15.097, 47.3765], glockner: [12.694, 47.074], dachstein: [13.62, 47.47], feldbach: [15.8883, 46.9531],
};
const profiles = ['richi-local-v1', 'richi-surface-v4', 'richi-weidweg-v1'];

function queries(rulesFile, searchFile) {
  // the planner's routingParameters (app/src/config/routing-policy.ts)
  const rules = JSON.parse(readFileSync(rulesFile, 'utf8'));
  const search = JSON.parse(readFileSync(searchFile, 'utf8'));
  const planner = { ...search, ...rules.parameters };
  const list = [];
  // the planner's request(): profile, lonlats, format, alternativeidx, extra, then the profile: parameters
  const add = (group, points, { profile = rules.profile, extra = {}, overrides = planner } = {}) => {
    const params = new URLSearchParams({ profile, lonlats: points.map(p => p.join(',')).join('|'), format: 'geojson', alternativeidx: '0', ...extra });
    for (const [name, value] of Object.entries(overrides)) params.set(`profile:${name}`, String(value));
    list.push([group, params.toString()]);
  };
  const raw = (group, query) => list.push([group, query]);
  const roundTrip = (radius, direction, points = 5, more = {}) =>
    ({ engineMode: '4', roundTripDistance: String(radius), direction: String(direction), roundTripPoints: String(points), ...more });
  const offset = ([lon, lat], dlon, dlat) => [+(lon + dlon).toFixed(6), +(lat + dlat).toFixed(6)];

  // round trips as the loop suggestions send them: radii, directions, starts
  Object.values(starts).forEach((start, i) => {
    for (const [j, radius] of [2500, 7000, 16000].entries()) {
      add('roundtrip', [start], { extra: roundTrip(radius + 37 * i, [0, 77, 180, 269, 315][(i + j) % 5]) });
    }
  });
  // round trips: other point counts (out of range falls back to 5), same way back, other profiles,
  // without the planner's parameters
  [3, 4, 7, 12, 20, 25, 2].forEach((points, i) => add('roundtrip-points', [Object.values(starts)[i]], { extra: roundTrip(6000, 45 * i, points) }));
  add('roundtrip-sameway', [starts.graz], { extra: roundTrip(5000, 120, 5, { allowSamewayback: '1' }) });
  add('roundtrip-sameway', [starts.salzburg], { extra: roundTrip(9000, 300, 5, { allowSamewayback: '1' }) });
  for (const profile of profiles.slice(1)) {
    add('roundtrip-profiles', [starts.leoben], { profile, extra: roundTrip(8000, 200) });
    add('roundtrip-profiles', [starts.wien], { profile, extra: roundTrip(4000, 30), overrides: search });
  }
  add('roundtrip-defaults', [starts.graz], { extra: roundTrip(4000, 10), overrides: {} });
  add('roundtrip-defaults', [starts.ljubljana], { profile: 'richi-weidweg-v1', extra: roundTrip(3000, 250), overrides: {} });

  // A to B: short and long legs, via points, all profiles
  const legs = [
    [starts.graz, offset(starts.graz, 0.012, 0.009)],
    [starts.wien, offset(starts.wien, -0.03, 0.02)],
    [starts.graz, starts.leoben],
    [starts.linz, starts.salzburg],
    [starts.klagenfurt, starts.ljubljana],
    [starts.innsbruck, offset(starts.innsbruck, 0.25, -0.05)],
    [starts.bratislava, starts.wien],
    [starts.feldbach, starts.graz],
    [starts.graz, starts.klagenfurt],
  ];
  for (const profile of profiles) {
    legs.forEach((leg, i) => add('ab', leg, { profile, overrides: i % 3 === 2 ? search : planner }));
  }
  add('ab-via', [starts.graz, offset(starts.graz, 0.1, 0.05), starts.leoben]);
  add('ab-via', [starts.salzburg, offset(starts.salzburg, 0.2, -0.1), offset(starts.salzburg, 0.35, 0.02), starts.linz]);
  add('ab-via', [starts.ljubljana, offset(starts.ljubljana, 0.05, 0.04), offset(starts.ljubljana, 0.1, 0.0)], { profile: 'richi-surface-v4' });
  add('ab-via', [starts.brno, offset(starts.brno, 0.2, 0.0), offset(starts.brno, 0.2, -0.15), offset(starts.brno, 0.0, -0.1)]);
  // the planner snaps a point with a leg from the point to itself, and short legs stay on one way
  for (const start of [starts.graz, starts.bozen, offset(starts.dachstein, 0.01, 0.0)]) add('ab-snap', [start, start]);
  add('ab-snap', [starts.graz, offset(starts.graz, 0.0002, 0.0001)]);
  add('ab-snap', [offset(starts.wien, 0.0004, 0.0), starts.wien]);
  // more parameters: alternatives, a start heading, same way back, named and meeting points, defaults
  for (const alternativeidx of ['1', '2', '3']) add('ab-params', [starts.graz, starts.leoben], { extra: { alternativeidx } });
  add('ab-params', [starts.linz, offset(starts.linz, 0.1, 0.05)], { extra: { heading: '90' } });
  add('ab-params', [starts.wien, offset(starts.wien, 0.05, 0.05)], { extra: { heading: '271' } });
  add('ab-params', [starts.graz, offset(starts.graz, 0.06, 0.03)], { extra: { allowSamewayback: '1' } });
  add('ab-params', [starts.graz, offset(starts.graz, 0.06, 0.03), offset(starts.graz, 0.1, 0.0)], { extra: { allowSamewayback: '1' } });
  raw('ab-params', `profile=richi-local-v1&lonlats=15.4395%2C47.0707%2Chome%7C15.47%2C47.09%2Cm%7C15.5%2C47.06&format=geojson`);
  add('ab-params', [starts.graz, offset(starts.graz, 0.05, 0.03)], { overrides: {} });
  // an absolute profile name (Java still reads it from the profile directory), parameters Java ignores
  // when they hold no nogo or poi
  raw('ab-params', 'profile=%2Frichi-local-v1&lonlats=15.4395%2C47.0707%7C15.45%2C47.08&format=geojson');
  raw('ab-params', 'profile=richi-local-v1&lonlats=15.4395%2C47.0707%7C15.45%2C47.08&format=geojson&nogoLats=47.1&pois=15.44%2C47.07&nogos=%7C');
  add('ab-params', [starts.graz, offset(starts.graz, 0.05, 0.03)], { overrides: { ...planner, showspeed: 1 } });
  add('ab-params', [starts.graz, offset(starts.graz, 0.05, 0.03)], { overrides: { ...planner, inverseRouting: 1 } });

  // errors: no data, the sea, bad parameters, BRouter's exceptions
  add('errors', [[5.0, 45.5], [5.1, 45.6]]);
  add('errors', [[9.9995, 47.25], [10.01, 47.26]]);
  add('errors', [[5.0, 45.5]], { extra: roundTrip(5000, 90) });
  add('errors', [[12.9, 45.1], [13.0, 45.15]]);
  add('errors', [[13.2, 44.95]], { extra: roundTrip(3000, 0) });
  add('errors', [[12.9, 45.1], [13.0, 45.15]], { overrides: { ...planner, use_dynamic_range: 0 } });
  add('errors', [starts.graz, offset(starts.graz, 0.01, 0.01)], { overrides: { ...planner, use_dynamic_range: 0, waypointCatchingRange: 1 } });
  add('errors', [starts.graz]);
  raw('errors', 'profile=richi-local-v1&format=geojson');
  raw('errors', 'profile=richi-local-v1&lonlats=15.4x%2C47.07%7C15.5%2C47.1');
  raw('errors', 'profile=richi-local-v1&lonlats=15.4');
  raw('errors', 'profile=richi-local-v1&lonlats=15.4%2C');
  raw('errors', 'profile=richi-local-v1&lonlats=%2C47.1%7C15.5%2C47.1');
  raw('errors', 'profile=richi-local-v1&lonlats=%7C%7C');
  raw('errors', 'lonlats=15.4395%2C47.0707%7C15.45%2C47.08');
  raw('errors', 'profile=nope&lonlats=15.4395%2C47.0707%7C15.45%2C47.08');
  raw('errors', 'profile=richi-local-v1&lonlats=15.4395%2C47.0707%7C15.45%2C47.08&engineMode=1');
  raw('errors', 'profile=richi-local-v1&lonlats=15.4395%2C47.0707%7C15.45%2C47.08&engineMode=7');
  raw('errors', 'profile=richi-local-v1&lonlats=15.4395%2C47.0707%7C15.45%2C47.08&engineMode=x');
  raw('errors', 'profile=richi-local-v1&lonlats=15.4395%2C47.0707&engineMode=4&direction=90&roundTripDistance=abc');
  raw('errors', 'profile=richi-local-v1&lonlats=15.4395%zz47.0707%7C15.45%2C47.08');
  raw('errors', 'profile=richi-local-v1&lonlats=15.4395%2C47.0707%7C15.45%2C47.08%2');
  raw('errors', 'profile=richi-local-v1&lonlats=15.4395%2C47.0707%7C15.45%2C47.08&x=%2g');
  raw('errors', 'profile=richi-local-v1&lonlats=15.4395%2C47.0707%7C15.45%2C47.08&x=%-1');
  raw('errors', 'profile=richi-local-v1&lonlats=15.4395%2C47.0707%7C15.45%2C47.08&x=%\u00e41');
  for (const name of ['%C3%28', '%E2%82x', '%F0%9F%98', '%ED%A0%80', '%C0%AF', 'p%C3%A4th+one']) {
    raw('errors', `profile=${name}&lonlats=15.4395%2C47.0707%7C15.45%2C47.08`);
  }
  raw('errors', 'profile=richi-local-v1&lonlats=15.4395%2C47.0707%7C15.45%2C47.08&profile%3Apass1coefficient=abc');
  raw('errors', 'profile=richi-local-v1&lonlats=15.4395%2C47.0707%7C15.45%2C47.08&profile%3Anosuchvariable=1');
  return list.map(([group, query], i) => `${group}-${i}\t${query}`).join('\n') + '\n';
}

function compare(queriesFile, javaFile, rustFile) {
  const read = file => new Map(readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
    const answer = JSON.parse(line);
    return [answer.id, answer];
  }));
  const [java, rust] = [read(javaFile), read(rustFile)];
  const groups = new Map();
  let different = 0, javaMs = 0, rustMs = 0;
  for (const line of readFileSync(queriesFile, 'utf8').split('\n').filter(Boolean)) {
    const [id, query] = line.split('\t');
    const group = id.slice(0, id.lastIndexOf('-'));
    const stats = groups.get(group) ?? { answers: 0, errors: 0, different: 0 };
    groups.set(group, stats);
    const [j, r] = [java.get(id), rust.get(id)];
    stats.answers++;
    javaMs += j?.ms ?? 0;
    rustMs += r?.ms ?? 0;
    if (j?.error !== undefined) stats.errors++;
    const [jt, rt] = [j ? j.geojson ?? `error: ${j.error}` : 'no java answer', r ? r.geojson ?? `error: ${r.error}` : 'no rust answer'];
    if (j && jt === rt) continue;
    stats.different++;
    if (different++ < 10) {
      const [jl, rl] = [jt.split('\n'), rt.split('\n')];
      let n = 0;
      while (n < jl.length && jl[n] === rl[n]) n++;
      console.log(`different: ${id} ${query}\n  line ${n + 1}\n  java: ${jl[n]}\n  rust: ${rl[n]}`);
    }
  }
  for (const [group, s] of groups) console.log(`${group.padEnd(20)} ${String(s.answers).padStart(4)} answers (${s.errors} errors), ${s.different} different`);
  const total = [...groups.values()].reduce((sum, s) => sum + s.answers, 0);
  console.log(`routes: ${total} answers, ${different} different; time java ${(javaMs / 1000).toFixed(1)} s, rust ${(rustMs / 1000).toFixed(1)} s`);
  process.exitCode = different ? 1 : 0;
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'queries') process.stdout.write(queries(args[0], args[1]));
else if (mode === 'compare') compare(...args);
else throw new Error(`unknown mode ${mode}`);

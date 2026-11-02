// The engine's elevation profile (POST /profile, engine/planner/src/profile.rs) against the planner's TypeScript
// (buildGpxTrack, gradientRuns, drawProfile) on routes from the engine's /leg, one or several legs each.
//   node parity/profile.mjs <engine origin>        e.g. http://127.0.0.1:17796 (richi-engine serve)
import assert from 'node:assert/strict';
import { buildGpxTrack } from '../../src/domain/gpx-track.ts';
import { gradientBands, gradientRuns } from '../../src/domain/gpx-inspection.ts';
import { routingParameters, routingProfile } from '../../src/config/routing-policy.ts';

const origin = process.argv[2] ?? 'http://127.0.0.1:17796';
const at = {
  graz: [15.4395, 47.0707], schoeckl: [15.4697, 47.1997], leibnitz: [15.5386, 46.7826], leoben: [15.097, 47.3765],
  gleisdorf: [15.7089, 47.1042], innsbruck: [11.3933, 47.2692], brenner: [11.5072, 47.0046], feldbach: [15.8883, 46.9531],
  wien: [16.3725, 48.2085], salzburg: [13.055, 47.8095], glockner: [12.694, 47.074],
};
const routes = [['graz', 'schoeckl'], ['graz', 'leibnitz'], ['graz', 'leoben'], ['innsbruck', 'brenner'],
  ['graz', 'gleisdorf', 'feldbach', 'leibnitz'], ['salzburg', 'glockner'], ['wien', 'graz']];

async function leg(from, to) {
  const params = new URLSearchParams({ profile: routingProfile, lonlats: `${from.join(',')}|${to.join(',')}`, format: 'geojson', alternativeidx: '0' });
  for (const [name, value] of Object.entries(routingParameters)) params.set(`profile:${name}`, String(value));
  const response = await fetch(`${origin}/leg?${params}`);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

let points = 0;
for (const names of routes) {
  const legs = [];
  for (let i = 1; i < names.length; i++) legs.push(await leg(at[names[i - 1]], at[names[i]]));
  // the planner's route profile (src/stores/route-profile.store.ts)
  const track = buildGpxTrack('', legs.map(leg => ({ name: '', coordinates: leg.coordinates,
    elevations: leg.elevations ?? leg.coordinates.map(() => null), distanceMeters: leg.distanceMeters })), { connected: true });
  const response = await fetch(`${origin}/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ legs }) });
  const engine = await response.json();
  const name = names.join(' → ');
  assert.ok(track.profile && engine, name);
  assert.equal(engine.distance, track.distanceMeters, name);
  assert.equal(engine.minimum, track.profile.minimum, name);
  assert.equal(engine.maximum, track.profile.maximum, name);
  const colors = gradientRuns(track).map(run => [run.from, gradientBands.findIndex(band => band.color === run.color)]);
  assert.deepEqual(engine.colors, colors, `${name}: colours`);
  // the planner's path: "M x,y l0.01,0 L x,y …", a run per M
  const runs = track.profile.path.trim().split('M').filter(Boolean)
    .map(run => run.replace(/l0\.01,0/g, '').trim().split(/\s*L\s*/).map(point => point.split(',').map(Number)));
  assert.equal(engine.runs.length, runs.length, `${name}: runs`);
  engine.runs.forEach((run, r) => {
    assert.equal(run.length, runs[r].length, `${name}: points of run ${r}`);
    // both round to a tenth; a tie may round either way
    run.forEach((point, p) => assert.ok(Math.abs(point[0] - runs[r][p][0]) <= 0.1 + 1e-9 && Math.abs(point[1] - runs[r][p][1]) <= 0.1 + 1e-9,
      `${name}: run ${r} point ${p}: ${point} vs ${runs[r][p]}`));
    points += run.length;
  });
  console.log(`${name}: ${Math.round(track.distanceMeters / 100) / 10} km, ${colors.length} colour runs, ${engine.runs.flat().length} points: same`);
}
console.log(`Profiles of ${routes.length} routes the same as the planner's (${points} points).`);

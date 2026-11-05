// The engine's surface sections (POST /surfaces, engine/planner/src/surfaces.rs) against the planner's TypeScript
// (inspectSurfaces) on routes from the engine's /leg, one or several legs each.
//   node parity/surfaces.mjs <engine origin>        e.g. http://127.0.0.1:17796 (richi-engine serve)
import assert from 'node:assert/strict';
import { inspectSurfaces } from '../../src/domain/route-surfaces.ts';
import { legId } from '../../src/domain/route-model.ts';
import { routingParameters, routingProfile } from '../../src/config/routing-policy.ts';

const origin = process.argv[2] ?? 'http://127.0.0.1:17796';
const at = {
  graz: [15.4395, 47.0707], schoeckl: [15.4697, 47.1997], leibnitz: [15.5386, 46.7826], leoben: [15.097, 47.3765],
  gleisdorf: [15.7089, 47.1042], innsbruck: [11.3933, 47.2692], brenner: [11.5072, 47.0046], feldbach: [15.8883, 46.9531],
  wien: [16.3725, 48.2085], salzburg: [13.055, 47.8095], glockner: [12.694, 47.074], plabutsch: [15.3936, 47.0867],
};
const routes = [['graz', 'schoeckl'], ['graz', 'leibnitz'], ['graz', 'leoben'], ['innsbruck', 'brenner'],
  ['graz', 'gleisdorf', 'feldbach', 'leibnitz'], ['salzburg', 'glockner'], ['wien', 'graz'], ['graz', 'plabutsch', 'graz']];

async function leg(from, to) {
  const params = new URLSearchParams({ profile: routingProfile, lonlats: `${from.join(',')}|${to.join(',')}`, format: 'geojson', alternativeidx: '0' });
  for (const [name, value] of Object.entries(routingParameters)) params.set(`profile:${name}`, String(value));
  const response = await fetch(`${origin}/leg?${params}`);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

let count = 0;
for (const names of routes) {
  const legs = [];
  for (let i = 1; i < names.length; i++) legs.push(await leg(at[names[i - 1]], at[names[i]]));
  // the planner's points and legs, as its route store keeps them
  const points = names.map((name, i) => ({ id: `p${i}`, type: 'stop', coord: at[name] }));
  const ids = legs.map((_, i) => legId(`p${i}`, `p${i + 1}`));
  const planner = inspectSurfaces(points, Object.fromEntries(legs.map((leg, i) => [ids[i], { ...leg, id: ids[i], status: 'routed' }])));
  const response = await fetch(`${origin}/surfaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ legs }) });
  assert.equal(response.status, 200, await response.clone().text());
  const engine = await response.json();
  const name = names.join(' → ');
  assert.equal(engine.distance, planner.distanceMeters, name);
  assert.deepEqual(engine.totals, planner.totals, `${name}: totals`);
  assert.deepEqual(engine.sections, planner.sections.map(section => ({
    from: section.fromMeters, to: section.toMeters, surface: section.surface, corrected: section.corrected,
    parts: section.parts.map(part => [ids.indexOf(part.legId), part.fromIndex, part.toIndex]),
  })), `${name}: sections`);
  count += engine.sections.length;
  console.log(`${name}: ${engine.sections.length} sections, ${engine.totals.length} surfaces: same`);
}
console.log(`Surfaces of ${routes.length} routes the same as the planner's (${count} sections).`);

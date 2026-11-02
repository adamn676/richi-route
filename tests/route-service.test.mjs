import assert from 'node:assert/strict';
import test from 'node:test';
import { courseFit, routingEngine, traceLoops } from '../src/services/route.service.ts';
import { PlacementError } from '../src/domain/route-model.ts';
import { routingPolicyVersion } from '../src/config/routing-policy.ts';
import { requestFor } from '../experiments/routing/engines.mjs';

const from = [15.39325, 47.07655];
const to = [12.45688, 47.00334];
// The routing service's answer at /leg: the leg the planner keeps.
const leg = (coordinates, distanceMeters) => Response.json({ coordinates, elevations: null, distanceMeters, ascentMeters: null, surfaces: [] });

test('editor and comparison share the rule revision and search settings; historical presets remain reproducible', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const { pathname, searchParams: query } = new URL(url, 'http://localhost');
    assert.equal(pathname, '/routing/leg');
    requests.push(query);
    const coords = query.get('lonlats').split('|').map(pair => pair.split(',').map(Number));
    return leg(coords, coords[0][0] === coords[1][0] ? 0 : 338830);
  });
  assert.deepEqual(await routingEngine.snap(from, new AbortController().signal), from);
  const routed = await routingEngine.routeLeg(from, to, new AbortController().signal);
  assert.deepEqual(routed, { coordinates: [from, to], elevations: null, distanceMeters: 338830, ascentMeters: null, surfaces: [],
    routingPolicy: routingPolicyVersion }, 'The leg as the routing service reads it, with the routing settings');
  const points = [from, to].map(coord => ({ role: 'stop', coord }));
  const comparison = new URL(requestFor('brouter', points, 'local-rules-v1').url).searchParams;
  assert.deepEqual([...requests[1]].sort(), [...comparison].sort());
  assert.equal(requests[0].get('profile:pass1coefficient'), '2');
  assert.equal(requests[0].get('profile:pass2coefficient'), '1');
  assert.equal(comparison.has('nogos'), false, 'Local avoidance rules are loaded by the engine');
  assert.ok(comparison.has('profile:richiroute_rules_3'), 'The complete revision accompanies each request');
  const baseline = new URL(requestFor('brouter', points, 'weidweg-local-v1').url).searchParams;
  for (const [settings, coefficient] of [['weidweg-search-v1', '0.5'], ['weidweg-search-v2', '0.7']]) {
    const previous = new URL(requestFor('brouter', points, settings).url).searchParams;
    assert.equal(previous.get('profile:pass2coefficient'), coefficient);
    previous.delete('profile:pass2coefficient');
    assert.deepEqual([...previous].sort(), [...baseline].sort());
  }
});

test('routing failures explain the cause without exposing arbitrary server content', async t => {
  // Problems fixed by moving the point (a stop shows them in its row) apart from those fixed elsewhere, such as installing
  // map data, which the panel reports with a retry.
  for (const [status, body, expected, place] of [
    [400, 'datafile E10_N45.rd5 not found\n', /Kartendaten \(E10_N45\.rd5\)/, false],
    [400, 'no track found at pass=1', /Keine passende Fahrradverbindung/, true],
    [400, 'pass1 timeout after 60 seconds', /Zeitlimit/, false],
    [400, 'memory limit reached', /Speicherlimit/, false],
    [400, 'local routing rules version mismatch', /Routing-Regeln wurden geändert/, false],
    [503, '', /Routing-Dienst ist nicht erreichbar/, false],
    [500, '<html>Internal server error</html>', /nicht berechnet werden \(HTTP 500\)/, false],
  ]) {
    await t.test(`${status}: ${body || 'empty response'}`, async t => {
      t.mock.method(globalThis, 'fetch', async () => new Response(body, { status }));
      await assert.rejects(routingEngine.routeLeg(from, to, new AbortController().signal), expected);
      await assert.rejects(routingEngine.snap(to, new AbortController().signal), error => expected.test(error.message) && (error instanceof PlacementError) === place);
    });
  }
});

test('network failure and timeout have distinct messages; cancellation stays cancelled', async t => {
  const controller = new AbortController();
  let failure = new TypeError('Failed to fetch');
  t.mock.method(globalThis, 'fetch', async () => { throw failure; });
  await assert.rejects(routingEngine.snap(to, controller.signal), /Routing-Dienst ist nicht erreichbar/);
  failure = new DOMException('Timed out', 'TimeoutError');
  await assert.rejects(routingEngine.snap(to, controller.signal), /Zeitlimit/);
  controller.abort();
  await assert.rejects(routingEngine.snap(to, controller.signal), error => error === controller.signal.reason);
});

test('foreground routing takes the next slot ahead of queued surface lookup', async t => {
  const { traceGpxPortion } = await import('../src/services/route.service.ts');
  const releases = [], started = [];
  t.mock.method(globalThis, 'fetch', url => new Promise(resolve => {
    const coords = new URL(url, 'http://localhost').searchParams.get('lonlats').split('|').map(p => p.split(',').map(Number));
    started.push(coords[0][0]);
    releases.push(() => resolve(leg(coords, 100)));
  }));
  const signal = new AbortController().signal;
  const running = Array.from({ length: 6 }, (_, i) => routingEngine.routeLeg([i, 47], [i + .01, 47], signal));
  await new Promise(resolve => setTimeout(resolve, 0));
  const background = traceGpxPortion([[10, 47], [10.01, 47]], signal);
  const foreground = routingEngine.routeLeg([11, 47], [11.01, 47], signal);
  releases.shift()();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 11]);
  releases.shift()();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(started.at(-1), 10);
  releases.splice(0).forEach(release => release());
  await Promise.all([...running, background, foreground]);
});

test('loop suggestions are one request with the planner\'s profile, failing like a route', async t => {
  let asked;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    asked = { url, method: init.method, type: init.headers['Content-Type'], body: JSON.parse(init.body) };
    return Response.json([]);
  });
  const earlier = [{ cells: ['1,2'], weight: .5 }], dice = Array(13).fill(.25);
  assert.deepEqual(await traceLoops(from, { meters: 60000, ascent: 600 }, dice, earlier, new AbortController().signal), []);
  assert.equal(asked.url, '/routing/loops');
  assert.deepEqual([asked.method, asked.type], ['POST', 'application/json'], 'Nothing another web page could send unasked');
  const { parameters, ...rest } = asked.body;
  assert.deepEqual(rest, { profile: 'richi-local-v1', start: from, target: { meters: 60000, ascent: 600 }, random: dice, earlier });
  assert.equal(parameters.pass1coefficient, '2', 'Parameters go as the route service sends them');
  t.mock.method(globalThis, 'fetch', async () => new Response('datafile E10_N45.rd5 not found\n', { status: 400 }));
  await assert.rejects(traceLoops(from, { meters: 60000, ascent: 600 }, dice, [], new AbortController().signal), /Kartendaten \(E10_N45\.rd5\)/);
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('Timed out', 'TimeoutError'); });
  await assert.rejects(traceLoops(from, { meters: 60000, ascent: 600 }, dice, [], new AbortController().signal), /Zeitlimit/);
});

test('a FIT course is one JSON request to the routing service, failing with a message of its own', async t => {
  let asked;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    asked = { url, method: init.method, type: init.headers['Content-Type'], body: JSON.parse(init.body) };
    return Response.json({ parts: [{ name: 'Graz → Lienz', fit: btoa(String.fromCharCode(14, 16, 255)) }] });
  });
  const track = { coordinates: [[...from, 300], to], stops: [] };
  const fit = await courseFit('Graz → Lienz', track);
  assert.equal(fit.length, 1);
  assert.deepEqual([...new Uint8Array(await fit[0].arrayBuffer())], [14, 16, 255]);
  assert.deepEqual(asked, { url: '/routing/fit', method: 'POST', type: 'application/json', body: { name: 'Graz → Lienz', ...track } });
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 502 }));
  await assert.rejects(courseFit('', track), /nicht erreichbar/);
  t.mock.method(globalThis, 'fetch', async () => new Response('coordinates must be a list\n', { status: 400 }));
  await assert.rejects(courseFit('', track), /FIT-Datei konnte nicht erstellt werden \(HTTP 400: coordinates must be a list\)/);
});

test('a long route comes as every part the routing service makes of it, in one answer', async t => {
  let asked = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    asked++;
    return Response.json({ parts: [1, 2, 3].map(i => ({ name: `Wien → Bregenz (Teil ${i}/3)`, fit: btoa(String.fromCharCode(i)) })) });
  });
  const parts = await courseFit('Wien → Bregenz', { coordinates: [[...from, 300], to, [...from, 310]], stops: [1] });
  assert.deepEqual(await Promise.all(parts.map(async part => [...new Uint8Array(await part.arrayBuffer())])), [[1], [2], [3]]);
  assert.equal(asked, 1);
});

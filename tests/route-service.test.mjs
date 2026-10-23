import assert from 'node:assert/strict';
import test from 'node:test';
import { routingEngine } from '../src/services/route.service.ts';
import { requestFor } from '../experiments/routing/engines.mjs';

const from = [15.39325, 47.07655];
const to = [12.45688, 47.00334];

test('editor and comparison share the rule revision and search settings; historical presets remain reproducible', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const query = new URL(url, 'http://localhost').searchParams;
    requests.push(query);
    const coords = query.get('lonlats').split('|').map(pair => pair.split(',').map(Number));
    return Response.json({ features: [{ geometry: { type: 'LineString', coordinates: coords },
      properties: { 'track-length': coords[0][0] === coords[1][0] ? '0' : '338830' } }] });
  });
  await routingEngine.snap(from, new AbortController().signal);
  await routingEngine.routeLeg(from, to, new AbortController().signal);
  const points = [from, to].map(coord => ({ role: 'stop', coord }));
  const comparison = new URL(requestFor('brouter', points, 'local-rules-v1').url).searchParams;
  assert.deepEqual([...requests[1]].sort(), [...comparison].sort());
  assert.equal(requests[0].get('profile:pass1coefficient'), '2');
  assert.equal(requests[0].get('profile:pass2coefficient'), '0.7');
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
  for (const [status, body, expected] of [
    [400, 'datafile E10_N45.rd5 not found\n', /Kartendaten \(E10_N45\.rd5\)/],
    [400, 'no track found at pass=1', /Keine passende Fahrradverbindung/],
    [400, 'pass1 timeout after 60 seconds', /Zeitlimit/],
    [400, 'memory limit reached', /Speicherlimit/],
    [400, 'local routing rules version mismatch', /Routing-Regeln wurden geändert/],
    [503, '', /Routing-Dienst ist nicht erreichbar/],
    [500, '<html>Internal server error</html>', /nicht berechnet werden \(HTTP 500\)/],
  ]) {
    await t.test(`${status}: ${body || 'empty response'}`, async t => {
      t.mock.method(globalThis, 'fetch', async () => new Response(body, { status }));
      await assert.rejects(routingEngine.routeLeg(from, to, new AbortController().signal), expected);
      await assert.rejects(routingEngine.snap(to, new AbortController().signal), expected);
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

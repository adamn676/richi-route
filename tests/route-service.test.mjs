import assert from 'node:assert/strict';
import test from 'node:test';
import { routingEngine } from '../src/services/route.service.ts';

const from = [15.39325, 47.07655];
const to = [12.45688, 47.00334];

test('routing failures explain the cause without exposing arbitrary server content', async t => {
  for (const [status, body, expected] of [
    [400, 'datafile E10_N45.rd5 not found\n', /Kartendaten \(E10_N45\.rd5\)/],
    [400, 'no track found at pass=1', /Keine passende Fahrradverbindung/],
    [400, 'pass1 timeout after 60 seconds', /Zeitlimit/],
    [400, 'memory limit reached', /Speicherlimit/],
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

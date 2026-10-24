import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardGeocode } from '../src/services/geocoding.service.ts';

const feature = (name = 'Hauptplatz', coord = [15.4385, 47.071]) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: coord },
  properties: { name, city: 'Graz', state: 'Steiermark', country: 'Österreich' },
});
const signal = () => new AbortController().signal;

test('search stays on the local service, encodes text and keeps distinct places with identical names', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url: new URL(url, 'http://127.0.0.1:5173'), options };
    return Response.json({ features: [feature(), feature(), feature('Hauptplatz', [15.44, 47.07])] });
  });
  const places = await forwardGeocode('  Graz & Hauptplatz  ', signal());
  assert.equal(request.url.origin, 'http://127.0.0.1:5173');
  assert.equal(request.url.pathname, '/geocoding/api/');
  assert.equal(request.url.searchParams.get('q'), 'Graz & Hauptplatz');
  assert.equal(request.url.searchParams.get('lang'), 'de');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.equal(places.length, 2);
  assert.deepEqual(places[0], { label: 'Hauptplatz, Graz, Steiermark', coord: [15.4385, 47.071],
    kind: 'place', components: { place: 'Graz', region: 'Steiermark', country: 'Österreich' } });
});

test('short or cancelled searches make no request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected request'); });
  await assert.rejects(forwardGeocode(' a ', signal()), /mindestens drei Zeichen/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(forwardGeocode('Graz', controller.signal), error => error === controller.signal.reason);
  assert.equal(fetch.mock.callCount(), 0);
});

test('empty results are valid, malformed responses and invalid coordinates are rejected', async t => {
  let body = { features: [] };
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  assert.deepEqual(await forwardGeocode('Graz', signal()), []);
  for (const invalid of [null, { features: null }, { features: [feature('Nowhere', [181, 47])] },
    { features: [feature('Nowhere', [15, 91])] },
    { features: [{ ...feature(), geometry: { type: 'LineString', coordinates: [15, 47] } }] }]) {
    body = invalid;
    await assert.rejects(forwardGeocode('Graz', signal()), /Adressdienst/);
  }
});

test('rate limits and unavailable services give useful messages without leaking server content', async t => {
  let status = 429;
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Private server detail</html>', { status }));
  await assert.rejects(forwardGeocode('Graz', signal()), /Zu viele Suchanfragen/);
  status = 503;
  await assert.rejects(forwardGeocode('Graz', signal()), /Adresssuche nicht erreichbar/);
});

test('offline, timeout and cancellation remain distinguishable', async t => {
  let error = new TypeError('Failed to fetch');
  t.mock.method(globalThis, 'fetch', async () => { throw error; });
  await assert.rejects(forwardGeocode('Graz', signal()), /Adresssuche nicht erreichbar/);
  error = new DOMException('Timed out', 'TimeoutError');
  await assert.rejects(forwardGeocode('Graz', signal()), /dauert zu lange/);
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    controller.abort();
    assert.equal(options.signal.aborted, true);
    throw options.signal.reason;
  });
  await assert.rejects(forwardGeocode('Graz', controller.signal), failure => failure === controller.signal.reason);
});

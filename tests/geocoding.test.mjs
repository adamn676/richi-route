import assert from 'node:assert/strict';
import test from 'node:test';
import { expandAbbreviations, forwardGeocode, reverseGeocode } from '../src/services/geocoding.service.ts';

const feature = (name = 'Hauptplatz', coord = [15.4385, 47.071]) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: coord },
  properties: { name, city: 'Graz', state: 'Steiermark', country: 'Österreich' },
});
const signal = () => new AbortController().signal;

test('search stays on the local service, prefers the map\'s surroundings and merges a name repeated within a town', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url: new URL(url, 'http://127.0.0.1:5173'), options };
    return Response.json({ features: [feature(), feature(), feature('Hauptplatz', [15.44, 47.07]),
      { ...feature(), properties: { ...feature().properties, postcode: '8010' } }, feature('Hauptplatz', [15.47, 47.05]),
      { ...feature('Hauptplatz', [15.7, 47.1]), properties: { ...feature().properties, city: 'Gleisdorf' } }] });
  });
  const places = await forwardGeocode('  Graz & Hauptplatz  ', signal(), [15.44, 47.07]);
  assert.equal(request.url.origin, 'http://127.0.0.1:5173');
  assert.equal(request.url.pathname, '/geocoding/api/');
  assert.equal(request.url.searchParams.get('q'), 'Graz & Hauptplatz');
  assert.equal(request.url.searchParams.get('lang'), 'de');
  assert.deepEqual(['lat', 'lon', 'bbox', 'limit'].map(key => request.url.searchParams.get(key)), ['47.07', '15.44', '5,45,20,50', '20']);
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.deepEqual(places.map(place => place.components.place), ['Graz', 'Gleisdorf'], 'One square per town');
  assert.deepEqual(places[0], { label: 'Hauptplatz, Graz, Steiermark', coord: [15.4385, 47.071],
    title: 'Hauptplatz', detail: 'Graz', category: 'place', components: { place: 'Graz', region: 'Steiermark', country: 'Österreich' } });
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

test('reverse lookup names the street and town, with the house number only when the house is right there', async t => {
  const at = [15.4743, 47.0908];
  let request, body;
  t.mock.method(globalThis, 'fetch', async url => { request = new URL(url, 'http://127.0.0.1:5173'); return Response.json(body); });
  const result = (properties, coord = at) => ({ features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: coord }, properties }] });
  body = result({ type: 'street', name: 'Hahnhofweg', postcode: '8010', city: 'Graz', state: 'Steiermark' });
  assert.equal(await reverseGeocode(at, signal()), 'Hahnhofweg, 8010 Graz');
  assert.equal(request.pathname, '/geocoding/reverse');
  assert.deepEqual([request.searchParams.get('lat'), request.searchParams.get('lon'), request.searchParams.get('radius')], ['47.0908', '15.4743', '0.3']);
  body = result({ type: 'house', street: 'Georgigasse', housenumber: '89', postcode: '8020', city: 'Graz' }, [15.4744, 47.0908]);
  assert.equal(await reverseGeocode(at, signal()), 'Georgigasse 89, 8020 Graz');
  body = result({ type: 'house', street: 'Deckerweg', housenumber: '31', postcode: '8063', city: 'Eggersdorf bei Graz' }, [15.4755, 47.0908]);
  assert.equal(await reverseGeocode(at, signal()), 'Deckerweg, 8063 Eggersdorf bei Graz', 'A house 90 m away does not lend its number');
  body = result({ type: 'house', name: 'Wegkreuz', street: 'Roseggerweg', postcode: '8044', city: 'Graz' });
  assert.equal(await reverseGeocode(at, signal()), 'Roseggerweg, 8044 Graz', 'A landmark gives its street');
  body = result({ type: 'house', street: 'Mortantsch', housenumber: '21', postcode: '8160', city: 'Mortantsch' }, [15.4743, 47.093]);
  assert.equal(await reverseGeocode(at, signal()), '8160 Mortantsch');
  body = result({ type: 'locality', name: 'Gollersattel', postcode: '8164', city: 'Gutenberg' });
  assert.equal(await reverseGeocode(at, signal()), 'Gollersattel, 8164 Gutenberg');
  body = { features: [] };
  assert.equal(await reverseGeocode(at, signal()), null);
});

test('an address knows its street; a street result does not need one', async t => {
  let body;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  body = { features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [15.39296, 47.07651] },
    properties: { type: 'house', osm_value: 'apartments', street: 'Georgigasse', housenumber: '95', postcode: '8020', city: 'Graz' } }] };
  const [house] = await forwardGeocode('Georgigasse 95', signal());
  assert.equal(house.street, 'Georgigasse');
  assert.equal(house.label, 'Georgigasse 95, 8020 Graz');
  body = { features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [15.393, 47.0769] },
    properties: { type: 'street', name: 'Georgigasse', postcode: '8020', city: 'Graz' } }] };
  assert.equal((await forwardGeocode('Georgigasse', signal()))[0].street, undefined);
});

test('abbreviations are searched written out as well; clutter goes; an exact name comes first', async t => {
  assert.equal(expandAbbreviations('Hbf Graz'), 'Hauptbahnhof Graz');
  assert.equal(expandAbbreviations('Mariatrosterstr. 3'), 'Mariatrosterstraße 3');
  assert.equal(expandAbbreviations('St. Radegund'), 'Sankt Radegund');
  assert.equal(expandAbbreviations('Gr. St. Florian'), 'Groß Sankt Florian');
  assert.equal(expandAbbreviations('Straßgang'), 'Straßgang');
  const queries = [];
  const kind = (name, osm_key, osm_value, more = {}) => ({ ...feature(name), properties: { ...feature(name).properties, osm_key, osm_value, ...more } });
  t.mock.method(globalThis, 'fetch', async url => {
    queries.push(new URL(url, 'http://127.0.0.1:5173').searchParams.get('q'));
    return Response.json({ features: [kind('Weinwarte Sankt Peter', 'tourism', 'viewpoint'), kind('Sankt Peter', 'highway', 'bus_stop'),
      kind('Dach', 'building', 'roof'), kind('Katastralgemeinde Sankt Peter', 'boundary', 'administrative'), kind('Sankt Peter', 'place', 'village')] });
  });
  const places = await forwardGeocode('St. Peter', signal());
  assert.deepEqual(queries, ['St. Peter', 'Sankt Peter']);
  assert.deepEqual(places.map(place => place.label), ['Sankt Peter, Graz, Steiermark', 'Weinwarte Sankt Peter, Graz, Steiermark']);
});

test('a suggestion shows what a place is and where: an address with its town, a town with its region, anything else town first', async t => {
  const at = (properties, coord = [15.44, 47.07]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coord }, properties });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ features: [
    at({ street: 'Herrengasse', housenumber: '5', postcode: '8010', city: 'Graz', state: 'Steiermark', country: 'Österreich' }),
    at({ name: 'Gleisdorf', osm_key: 'place', osm_value: 'town', state: 'Steiermark', country: 'Österreich' }, [15.7, 47.1]),
    at({ name: 'Schöckl', osm_key: 'natural', osm_value: 'peak', postcode: '8061', city: 'Sankt Radegund bei Graz', state: 'Steiermark' }, [15.47, 47.2]),
    at({ name: 'Pizzeria St. Radegund', osm_key: 'amenity', osm_value: 'restaurant', street: 'Hauptstraße', housenumber: '42', postcode: '8061',
      city: 'Sankt Radegund bei Graz', state: 'Steiermark' }, [15.49, 47.18]),
  ] }));
  const places = await forwardGeocode('Suche', signal());
  assert.deepEqual(places.map(place => [place.category, place.title, place.detail]), [
    ['address', 'Herrengasse 5', '8010 Graz'],
    ['town', 'Gleisdorf', 'Steiermark'],
    ['mountain', 'Schöckl', 'Sankt Radegund bei Graz'],
    ['place', 'Pizzeria St. Radegund', 'Sankt Radegund bei Graz · Hauptstraße 42'],
  ]);
});

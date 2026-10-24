import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGpxTrack } from '../src/domain/gpx-track.ts';
import { distanceMeters } from '../src/domain/route-model.ts';
import { decodeGpx, parseGpx } from '../src/domain/gpx-import.ts';

const segment = (coordinates, elevations, name = '') => ({ name, coordinates, elevations });

test('GPX decoding handles UTF-8, UTF-16 and declared Latin encodings without corrupting names', () => {
  const text = '<gpx version="1.1"><name>Größe</name></gpx>';
  assert.equal(decodeGpx(new TextEncoder().encode(text).buffer), text);
  for (const encoding of ['utf16le', 'utf16be']) {
    const bytes = Buffer.from('\ufeff' + text, 'utf16le');
    if (encoding === 'utf16be') bytes.swap16();
    assert.equal(decodeGpx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)), text);
  }
  const latin = '<?xml version="1.0" encoding="ISO-8859-1"?>' + text;
  const bytes = Buffer.from(latin, 'latin1');
  assert.equal(decodeGpx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)), latin);
  assert.throws(() => decodeGpx(new Uint8Array([0xff, 0xff]).buffer), /Zeichenkodierung/);
});

test('GPX parsing reads tracks across versions and namespaces and rejects invalid files', () => {
  const valid = '<trk><name>Test &amp; Runde</name><trkseg><trkpt lon="15" lat="47"><ele>100</ele></trkpt><trkpt lon="15.1" lat="47.1"/></trkseg><trkseg><trkpt lon="16" lat="48"><ele>500</ele></trkpt></trkseg></trk>';
  const wrap = (body, version = '1.1', ns = 'http://www.topografix.com/GPX/1/1') => `<gpx version="${version}" xmlns="${ns}">${body}</gpx>`;
  const standard = parseGpx(wrap(valid), 'test.gpx');
  assert.equal(standard.name, 'Test & Runde');
  assert.equal(standard.pointCount, 3);
  assert.deepEqual(standard.segments.map(segment => segment.name), ['Test & Runde', 'Test & Runde']);
  assert.equal(standard.elevationCount, 2);
  assert.equal(parseGpx(wrap('<name>Legacy</name>' + valid, '1.0', 'http://www.topografix.com/GPX/1/0'), 'old.gpx').name, 'Legacy');
  const prefixed = parseGpx('<g:gpx version="1.1" xmlns:g="http://www.topografix.com/GPX/1/1"><g:trk><g:trkseg><g:trkpt lon="0" lat="0"><g:ele>0</g:ele></g:trkpt></g:trkseg></g:trk></g:gpx>', 'prefix.gpx');
  assert.deepEqual(prefixed.segments[0].elevations, [0]);
  assert.equal(parseGpx(`<gpx version="1.1">${valid}</gpx>`, 'plain.gpx').pointCount, 3);
  assert.equal(parseGpx(wrap(valid + '<extensions xmlns:x="urn:test"><x:trk><x:trkseg><x:trkpt lon="200" lat="999"/></x:trkseg></x:trk></extensions>'), 'extensions.gpx').pointCount, 3);
  const mixed = parseGpx(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- export -->\n<gpx version='1.1' xmlns='http://www.topografix.com/GPX/1/1' xmlns:x="urn:x" x:a="1" xml:lang="de"><metadata><name><![CDATA[Ä & <b>]]> &#x31;</name></metadata><trk><trkseg><trkpt lat="1" lon="2"><ele> 5 </ele><ele>ignored</ele><x:e><ele>skipped</ele></x:e></trkpt></trkseg><name>Late</name></trk></gpx>\n`, 'mixed.gpx');
  assert.equal(mixed.name, 'Ä & <b> 1');
  assert.equal(mixed.segments[0].name, 'Late');
  assert.deepEqual(mixed.segments[0].elevations, [5]);
  const commented = parseGpx(wrap(`<!--${'x'.repeat(10_000_000)}--><trk><name>Zwei\r\nZeilen</name><trkseg><trkpt lon="1" lat="2"/></trkseg></trk>`), 'c.gpx');
  assert.equal(commented.name, 'Zwei\nZeilen', 'Large comments are skipped and line ends normalized');

  for (const xml of ['', '<gpx>', '<html/>', wrap(valid) + '<gpx/>', wrap(valid) + 'x', wrap(valid).replace('</trk>', '</trK>'),
    wrap(valid).replace('&amp;', '&'), wrap(valid).replace('&amp;', '&#0;'), wrap(valid).replace('lon="15"', 'lon=15'),
    wrap(valid).replace('<trk>', '<trk a="1" a="2">'), wrap(valid).replace('<trk>', '<p:trk>').replace('</trk>', '</p:trk>'),
    wrap(valid).replace('Runde', 'Run<de')]) {
    assert.throws(() => parseGpx(xml, 'invalid.gpx'), /kein gültiges GPX-XML|Version 1.0 und 1.1/, xml);
  }
  for (const xml of [wrap(''), wrap('<wpt lat="47" lon="15"/>'), wrap('<rte><rtept lat="47" lon="15"/></rte>'),
    wrap(valid, '2.0'), wrap(valid, '1.1', 'urn:not-gpx'),
    wrap(valid.replace('lon="15"', 'lon=""')), wrap(valid.replace('lat="47"', 'lat="91"')),
    wrap(valid.replace('lon="15"', 'lon="Infinity"')), wrap(valid.replace('lon="15"', 'lon="0x10"')),
    wrap(valid.replace('<ele>100</ele>', '<ele/>')), wrap(valid.replace('<ele>100</ele>', '<ele>NaN</ele>')),
    '<!DOCTYPE gpx [<!ENTITY x "hello">]>' + wrap(valid)]) {
    assert.throws(() => parseGpx(xml, 'invalid.gpx'), undefined, xml);
  }
});

test('GPX distance and ascent exclude jumps between track segments', () => {
  const segments = [
    segment([[15, 47], [15.01, 47]], [100, 120]),
    segment([[16, 48], [16.01, 48]], [500, 505]),
  ];
  const track = buildGpxTrack('Two tracks', 'two.gpx', segments);
  assert.equal(track.distanceMeters, distanceMeters(...segments[0].coordinates) + distanceMeters(...segments[1].coordinates));
  assert.equal(track.ascentMeters, 25);
  assert.equal(track.geojson.features.length, 2);
  assert.equal(track.pointCount, 4);
  assert.equal(track.profile.path.match(/M/g).length, 2);
  assert.equal(track.profile.areaPath.match(/Z/g).length, 2, 'Area fill does not bridge separate profile runs');
  assert.strictEqual(track.segments, segments);
});

test('connected segments draw one profile, separate segments break it', () => {
  const legs = [segment([[15, 47], [15.01, 47]], [100, 120]), segment([[15.01, 47], [15.02, 47]], [126, 110])];
  const moves = track => [...track.profile.path.matchAll(/M/g)].length;
  const areas = track => [...track.profile.areaPath.matchAll(/Z/g)].length;
  const separate = buildGpxTrack('', '', legs), connected = buildGpxTrack('', '', legs, { connected: true });
  assert.deepEqual([moves(separate), areas(separate)], [2, 2]);
  assert.deepEqual([moves(connected), areas(connected)], [1, 1]);
  assert.deepEqual(connected.distances, separate.distances);
});

test('missing elevations break the profile and prevent a misleading complete ascent', () => {
  const track = buildGpxTrack('Partial', 'partial.gpx', [
    segment([[15, 47], [15.01, 47], [15.02, 47], [15.03, 47]], [100, null, 300, 310]),
  ]);
  assert.equal(track.elevationCount, 3);
  assert.equal(track.ascentMeters, null);
  assert.equal(track.profile.path.match(/M/g).length, 2);
  assert.equal(track.profile.minimum, 100);
  assert.equal(track.profile.maximum, 310);
});

test('a single point remains visible and missing elevation stays unknown', () => {
  const track = buildGpxTrack('Point', 'point.gpx', [segment([[15, 47]], [null])]);
  assert.equal(track.geojson.features[0].geometry.type, 'Point');
  assert.equal(track.distanceMeters, 0);
  assert.equal(track.ascentMeters, null);
  assert.equal(track.profile, null);
  assert.deepEqual(track.bounds, [[15, 47], [15, 47]]);
});

test('date-line crossings use adjacent worlds for display while retaining original coordinates', () => {
  const coordinates = [[179.9, 10], [-179.9, 10], [-179.8, 10]];
  const track = buildGpxTrack('Date line', 'dateline.gpx', [segment(coordinates, [0, 1, 2])]);
  assert.deepEqual(track.segments[0].coordinates, coordinates);
  assert.ok(track.bounds[1][0] - track.bounds[0][0] < 1);
  assert.ok(track.geojson.features[0].geometry.coordinates[1][0] > 180);
  assert.ok(track.distanceMeters < 40000);
});

test('long tracks retain all data and keep the elevation SVG bounded with extrema', () => {
  const length = 100000;
  const coordinates = Array.from({ length }, (_, i) => [15 + i / 100000, 47]);
  const elevations = Array.from({ length }, (_, i) => i === 50001 ? 9999 : 300 + i % 20);
  const track = buildGpxTrack('Long', 'long.gpx', [segment(coordinates, elevations)]);
  assert.equal(track.pointCount, length);
  assert.equal(track.geojson.features[0].geometry.coordinates.length, length);
  assert.equal(track.segments[0].elevations.length, length);
  assert.equal(track.profile.maximum, 9999);
  assert.ok(track.profile.path.length < 25000);
  assert.ok(track.profile.areaPath.length < 26000, 'Area fill stays bounded for long tracks');
  assert.match(track.profile.path, /,10\.0/);
});

test('downsampled profiles keep heights beside missing values without bridging gaps', () => {
  const length = 10000;
  const coordinates = Array.from({ length }, (_, i) => [15 + i / 10000, 47]);
  const elevations = Array.from({ length }, (_, i) => i % 20 === 0 || (i >= 4000 && i < 6000) ? null : 300 + i % 7);
  const { profile } = buildGpxTrack('Gaps', 'gaps.gpx', [segment(coordinates, elevations)]);
  const points = [...profile.path.matchAll(/([ML])([\d.]+),/g)].map(([, command, x]) => ({ command, x: Number(x) }));
  assert.ok(points.length > 480, 'Every chart column with heights stays visible');
  assert.ok(profile.path.length < 25000 && profile.areaPath.length < 26000);
  assert.ok(points.every((point, i) => point.command === 'M' || !(points[i - 1].x < 121 && point.x > 179)),
    'The line does not bridge the missing block');
});

test('polar viewport bounds and nearly antipodal distances remain finite', () => {
  const track = buildGpxTrack('Polar', 'polar.gpx', [segment([[0, 90], [180, 90]], [0, 0])]);
  assert.ok(track.bounds[0][1] <= track.bounds[1][1]);
  assert.ok(track.bounds[1][1] < 90);
  for (const from of [[0, 0], [15.123, 47.999], [10, 60], [50.123456, 77.123456]]) {
    assert.ok(Number.isFinite(distanceMeters(from, [from[0] - 180, -from[1]])));
  }
});

test('extreme elevation values cannot produce an infinite ascent or an invalid SVG', () => {
  assert.throws(() => buildGpxTrack('Overflow', 'overflow.gpx', [
    segment([[15, 47], [16, 48]], [-1e308, 1e308]),
  ]), /Höhenwerte/);
});

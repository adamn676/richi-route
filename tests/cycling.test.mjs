import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'node:sqlite';
import { cyclingPoint, openCyclingPoints } from '../scripts/cycling/points.mjs';

const point = tags => ({ type: 'node', id: 1, lon: 15.43, lat: 47.07, tags });
test('water overlay requires explicit drinking-water data and excludes known restrictions', () => {
  assert.equal(cyclingPoint(point({ amenity: 'drinking_water' })).properties.kind, 'water');
  assert.equal(cyclingPoint(point({ natural: 'spring', drinking_water: 'yes' })).properties.kind, 'water');
  for (const tags of [{ amenity: 'fountain' }, { natural: 'spring' },
    { amenity: 'drinking_water', drinking_water: 'no' }, { amenity: 'drinking_water', drinking_water: 'conditional' },
    { amenity: 'drinking_water', access: 'private' }, { drinking_water: 'yes', access: 'no' },
    { amenity: 'drinking_water', disused: 'yes' }]) assert.equal(cyclingPoint(point(tags)), null);
  const result = cyclingPoint(point({ amenity: 'drinking_water', seasonal: 'summer', opening_hours: 'Mo-Fr 08:00-18:00', fee: 'yes' }));
  assert.equal(result.properties.seasonal, 'summer');
  assert.equal(result.properties.opening_hours, 'Mo-Fr 08:00-18:00');
  assert.equal(result.properties.fee, 'yes');
});
test('cycling services preserve OSM identity and polygon centres without guessing drinking water', () => {
  const feature = cyclingPoint({ type: 'way', id: 22, center: { lon: 16, lat: 48 }, tags: { shop: 'bicycle', name: 'Repair shop' } });
  assert.deepEqual(feature.geometry.coordinates, [16, 48]);
  assert.equal(feature.id, 'way/22'); assert.equal(feature.properties.kind, 'shop');
  assert.equal(cyclingPoint(point({ amenity: 'bicycle_repair_station' })).properties.kind, 'repair');
  assert.equal(cyclingPoint(point({ railway: 'station' })).properties.kind, 'station');
  assert.equal(cyclingPoint(point({ railway: 'halt' })).properties.kind, 'station');
  assert.equal(cyclingPoint(point({ landuse: 'railway' })), null);
});
test('local cycling query clips by viewport, bounds its response, and rejects oversized requests', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cycling-'));
  const file = path.join(directory, 'points.sqlite');
  let reader;
  try {
    const db = new Database(file);
    db.exec('CREATE TABLE metadata(value TEXT); CREATE TABLE points(id INTEGER PRIMARY KEY, feature TEXT); CREATE VIRTUAL TABLE positions USING rtree(id,minlon,maxlon,minlat,maxlat);');
    db.prepare('INSERT INTO metadata VALUES (?)').run(JSON.stringify({ updated: '2026-10-23T00:00:00Z' }));
    const feature = cyclingPoint(point({ amenity: 'drinking_water' }));
    db.prepare('INSERT INTO points VALUES(1, ?)').run(JSON.stringify(feature));
    db.exec('INSERT INTO positions VALUES(1,15.43,15.43,47.07,47.07);');
    db.close(); reader = openCyclingPoints(file);
    assert.deepEqual(reader.get('15.4,47,15.5,47.1').features, [feature]);
    assert.equal(reader.get('16,48,16.1,48.1').features.length, 0);
    assert.equal(reader.get('15.4,47,15.5,47.1').truncated, false);
    for (const bbox of [null, '', '1,2,3', 'a,2,3,4', '-180,-90,180,90', '16,48,15,47']) {
      assert.throws(() => reader.get(bbox), RangeError);
    }
  } finally { reader?.close(); await rm(directory, { recursive: true, force: true }); }
});

import { Database } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ImageryCache } from '../scripts/imagery/cache.mjs';
import { createRenderPool } from '../scripts/imagery/pool.mjs';
import { regionTiles, tilePoint } from '../scripts/imagery/regions.mjs';
import { createImagery, validTile } from '../scripts/imagery/service.mjs';

test('imagery cache evicts least recently used data and expires it after a week', () => {
  const cache = new ImageryCache(':memory:', 10, 'v1');
  try {
    cache.put('a', Buffer.from('1234'), ['AUT'], 0);
    cache.put('b', Buffer.from('5678'), ['CHE'], 1);
    cache.get('a', 70000);
    cache.put('c', Buffer.from('abcd'), ['FRA'], 70001);
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.size, 8);
    assert.equal(cache.get('a', 7 * 86400000 + 1).stale, true);
    assert.equal(cache.get('c', 70002).stale, false);
    cache.put('a', Buffer.from('12'), ['AUT'], 70003);
    assert.equal(cache.size, 6);
  } finally { cache.close(); }
});

test('imagery survives restart, invalidates changed sources and preserves unrelated tiles', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'richiroute-imagery-'));
  const file = path.join(directory, 'cache.sqlite');
  let cache;
  try {
    cache = new ImageryCache(file, 100, 'v1');
    const original = cache.put('a', Buffer.from('austria'), ['AUT']);
    cache.put('b', Buffer.from('swiss border'), ['CHE', 'FRA']);
    cache.invalidateSwiss('first'); cache.close();
    cache = new ImageryCache(file, 100, 'v1');
    assert.equal(cache.get('a').etag, original.etag);
    cache.invalidateSwiss('second');
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a').data.toString(), 'austria');
    cache.close(); cache = new ImageryCache(file, 100, 'v2');
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.size, 0);
  } finally { cache?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('imagery tile requests and offline selections reject invalid or excessive areas', () => {
  assert.equal(validTile(20, 2 ** 20 - 1, 0), true);
  for (const tile of [[21, 0, 0], [1, 2, 0], [1, -1, 0], [1, .5, 0], [NaN, 0, 0]]) assert.equal(validTile(...tile), false);
  assert.throws(() => regionTiles([-25, 34, 45, 72], 20), /4000/);
  assert.throws(() => regionTiles([15, 47, 14, 46], 16), /coverage/);
  assert.throws(() => regionTiles([15, 47, 16, 48], 21), /maxzoom/);
  const tiles = regionTiles([15.43, 47.07, 15.44, 47.08], 16);
  assert.equal(new Set(tiles.map(String)).size, tiles.length);
  const center = tilePoint(15.435, 47.075, 16).map(Math.floor);
  assert.ok(tiles.some(tile => tile.join() === [16, ...center].join()));
});

test('GPX corridors include intermediate segments and avoid downloading the whole bounding box', () => {
  const track = [[15, 47], [15.5, 47.5]];
  const tiles = regionTiles([15, 47, 15.5, 47.5], 14, [track], .2);
  const center = tilePoint(15.25, 47.25, 14).map(Math.floor);
  assert.ok(tiles.some(tile => tile.join() === [14, ...center].join()));
  const corner = tilePoint(15.01, 47.49, 14).map(Math.floor);
  assert.ok(!tiles.some(tile => tile.join() === [14, ...corner].join()));
});

test('renderer pool skips cancelled queued work, recovers after a crash and closes pending jobs', async () => {
  const worker = `const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.crash) process.exit(1);
      setTimeout(() => console.log(JSON.stringify(request)), request.delay ?? 0);
    });`;
  const pool = createRenderPool(process.execPath, ['-e', worker], { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    const busy = Array.from({ length: 4 }, (_, n) => pool.render({ n, delay: 100 }));
    const cancelled = assert.rejects(pool.render({ unexpected: true }, () => true), { name: 'AbortError' });
    const next = pool.render({ n: 5 });
    assert.deepEqual((await Promise.all(busy)).map(item => item.n), [0, 1, 2, 3]);
    await cancelled;
    assert.equal((await next).n, 5);
    await assert.rejects(pool.render({ crash: true }), /stopped/);
    assert.equal((await pool.render({ recovered: true })).recovered, true);
    const pending = assert.rejects(pool.render({ delay: 10000 }), /stopped/);
    pool.close(); await pending;
    await assert.rejects(pool.render({}), /closed/);
  } finally { pool.close(); }
});

test('obsolete active imagery cannot hold up the next viewport', async () => {
  const worker = `require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    setTimeout(() => console.log(JSON.stringify(request)), request.delay ?? 0);
  });`;
  const pool = createRenderPool(process.execPath, ['-e', worker], { stdio: ['pipe', 'pipe', 'inherit'] }, 1);
  let cancelled = false;
  try {
    const old = assert.rejects(pool.render({ delay: 10000 }, () => cancelled), { name: 'AbortError' });
    cancelled = true;
    const current = await pool.render({ current: true });
    assert.equal(current.current, true);
    await old;
  } finally { pool.close(); }
});


test('newer saved imagery wins over overlapping older files regardless of filename', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'richiroute-saved-imagery-'));
  const directory = path.join(root, '.cache/imagery');
  let service;
  try {
    await mkdir(path.join(directory, 'regions'), { recursive: true });
    await Promise.all(['overview.tif', 'index.json'].map(name => writeFile(path.join(directory, name), '')));
    for (const [name, created, data] of [['z-old', '2026-01-01T00:00:00Z', 'old'], ['a-new', '2026-02-01T00:00:00Z', 'new']]) {
      const db = new Database(path.join(directory, 'regions', name + '.mbtiles'));
      db.exec('CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);');
      db.prepare('INSERT INTO metadata VALUES (?, ?)').run('created', created);
      db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)').run(16, 35578, 42503, Buffer.from(data));
      db.close();
    }
    service = await createImagery(root, { offline: true });
    const result = await service.getTile(16, 35578, 2 ** 16 - 1 - 42503);
    assert.equal(result.data.toString(), 'new');
    assert.deepEqual(result.sources, ['saved-region']);
    assert.equal(result.cached, true);
  } finally { service?.close(); await rm(root, { recursive: true, force: true }); }
});

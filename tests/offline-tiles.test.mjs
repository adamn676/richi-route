import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { PMTiles, tileIdToZxy, zxyToTileId } from 'pmtiles';
import { drawnKinds, rewrite, strip, writeArchive } from '../scripts/offline/tiles.mjs';

// Protobuf by hand: a field is its number and wire type, then a varint or length-prefixed bytes.
const varint = value => { const out = []; while (value >= 0x80) { out.push(value % 0x80 | 0x80); value = Math.floor(value / 0x80); } out.push(value); return out; };
const bytes = (number, content) => [...varint(number << 3 | 2), ...varint(content.length), ...content];
const number = (field, value) => [...varint(field << 3), ...varint(value)];
const text = value => [...Buffer.from(value)];
const stringValue = value => bytes(1, text(value));
// A layer of polygons, one per kind, each tagged kind = its kind.
function layer(name, kinds) {
  const values = kinds.flatMap(kind => bytes(4, stringValue(kind)));
  const features = kinds.flatMap((_, i) => bytes(2, [...number(1, i + 1), ...bytes(2, [0, i]), ...number(3, 3), ...bytes(4, [9, 2, 2])]));
  return bytes(3, [...bytes(1, text(name)), ...features, ...bytes(3, text('kind')), ...values, ...number(15, 2)]);
}
const tile = (...layers) => Uint8Array.from(layers.flat());
const kindsOf = (data, name) => {
  const found = [];
  const walk = (b, visit) => { let i = 0; while (i < b.length) { let key = 0, shift = 0, x; do { x = b[i++]; key += (x & 0x7f) * 2 ** shift; shift += 7; } while (x & 0x80);
    if ((key & 7) === 2) { let length = 0; shift = 0; do { x = b[i++]; length += (x & 0x7f) * 2 ** shift; shift += 7; } while (x & 0x80); visit(key >> 3, b.subarray(i, i + length)); i += length; }
    else { do { x = b[i++]; } while (x & 0x80); } } };
  walk(data, (field, content) => {
    if (field !== 3) return;
    let layerName = '', values = [], features = 0;
    walk(content, (f, c) => { if (f === 1) layerName = Buffer.from(c).toString(); if (f === 4) walk(c, (_, v) => values.push(Buffer.from(v).toString())); if (f === 2) features++; });
    if (layerName === name) found.push(...values.slice(0, features ? values.length : 0), `features:${features}`);
  });
  return found;
};

test('the kinds a style draws, or none when a filter says more', () => {
  const style = [{ 'source-layer': 'landuse', filter: ['in', 'kind', 'forest', 'park'] }, { 'source-layer': 'landuse', filter: ['any', ['in', 'kind', 'runway']] },
    { 'source-layer': 'landuse', filter: ['==', 'kind', 'zoo'] }, { 'source-layer': 'roads', filter: ['all', ['==', 'kind', 'path'], ['>', 'z', 3]] }];
  assert.deepEqual([...drawnKinds(style, 'landuse')].sort(), ['forest', 'park', 'runway', 'zoo']);
  assert.equal(drawnKinds(style, 'roads'), null);
  assert.equal(drawnKinds(style, 'water'), null);
});

test('stripping leaves out the features of kinds not drawn, and other layers as they were', () => {
  const roads = layer('roads', ['path', 'meadow']);
  const stripped = strip(tile(layer('landuse', ['forest', 'meadow', 'farmland', 'park']), roads), 'landuse', new Set(['forest', 'park']));
  assert.ok(kindsOf(stripped, 'landuse').includes('features:2'));
  assert.ok(kindsOf(stripped, 'roads').includes('features:2'));
  assert.deepEqual(Uint8Array.from(stripped.subarray(stripped.length - roads.length)), Uint8Array.from(roads));
});

test('an archive written and read again gives every tile back, with leaf directories and repeated tiles', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tiles-'));
  try {
    // A few hundred tiles, with a root directory limit low enough that they need leaf directories.
    const ids = Array.from({ length: 600 }, (_, i) => zxyToTileId(14, 8800 + i % 30, 5700 + Math.floor(i / 30))).sort((a, b) => a - b);
    // Every seventh tile is the same sea, stored once.
    const text = id => `tile ${id % 7 === 0 ? 'sea' : id}`, content = id => gzipSync(Buffer.from(text(id)));
    const archive = path.join(directory, 'a.pmtiles');
    await writeArchive(archive, ids.map(tileId => ({ tileId, tile: content(tileId) })),
      { minZoom: 14, maxZoom: 14, bounds: [13.5, 46.6, 16.2, 47.8], center: [15.4, 47.1, 14], metadata: { name: 'test' } }, 200);
    const file = await readFile(archive);
    const reader = new PMTiles({ getKey: () => archive, getBytes: async (offset, length) => ({ data: file.buffer.slice(file.byteOffset + offset, file.byteOffset + offset + length) }) });
    const header = await reader.getHeader();
    assert.ok(header.leafDirectoryLength > 0, 'Leaf directories');
    assert.equal(header.numAddressedTiles, ids.length);
    assert.ok(header.numTileContents < ids.length, 'Repeated tiles stored once');
    assert.deepEqual(await reader.getMetadata(), { name: 'test' });
    for (const id of [ids[0], ids[7], ids[345], ids.at(-1)]) {
      const [z, x, y] = tileIdToZxy(id);
      const got = await reader.getZxy(z, x, y);
      // The reader unzips tiles itself.
      assert.equal(Buffer.from(got.data).toString(), text(id));
    }
    // Rewriting with a change reaches every tile.
    const changed = path.join(directory, 'b.pmtiles');
    await rewrite(archive, changed, data => Buffer.concat([Buffer.from(data), Buffer.from('!')]));
    const again = await readFile(changed);
    const second = new PMTiles({ getKey: () => changed, getBytes: async (offset, length) => ({ data: again.buffer.slice(again.byteOffset + offset, again.byteOffset + offset + length) }) });
    const [, x, y] = tileIdToZxy(ids[345]);
    assert.equal(Buffer.from((await second.getZxy(14, x, y)).data).toString(), `${text(ids[345])}!`);
    assert.equal((await second.getHeader()).numAddressedTiles, ids.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

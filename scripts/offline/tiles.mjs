// Map archives for a phone: vector tiles without the features the planner's style never draws, written as PMTiles v3
// (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
import { open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { PMTiles } from 'pmtiles';

const varint = (bytes, at) => {
  let value = 0, shift = 0, byte;
  do { byte = bytes[at.i++]; value += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
  return value;
};
// A protobuf message's fields: number, wire type, and where the field and (for bytes) its content lie.
function* fields(bytes, from = 0, to = bytes.length) {
  const at = { i: from };
  while (at.i < to) {
    const start = at.i, key = varint(bytes, at), type = key & 7;
    let content = at.i, value;
    if (type === 2) { const length = varint(bytes, at); content = at.i; at.i += length; }
    else if (type === 0) value = varint(bytes, at);
    else if (type === 5) at.i += 4;
    else if (type === 1) at.i += 8;
    else throw new Error(`Unexpected wire type ${type}`);
    yield { number: key >> 3, type, start, content, end: at.i, value };
  }
}
const text = (bytes, field) => Buffer.from(bytes.subarray(field.content, field.end)).toString();
function encodeVarint(value, out) {
  while (value >= 0x80) { out.push(value % 0x80 | 0x80); value = Math.floor(value / 0x80); }
  out.push(value);
}

// The kinds each source layer's style filters draw; a layer whose filters say more than "kind is one of" keeps all.
export function drawnKinds(styleLayers, sourceLayer) {
  const kinds = new Set();
  const collect = filter => {
    if (filter?.[0] === 'any') return filter.slice(1).every(collect);
    if (filter?.[0] === 'in' && filter[1] === 'kind') { filter.slice(2).forEach(kind => kinds.add(kind)); return true; }
    if (filter?.[0] === '==' && filter[1] === 'kind') { kinds.add(filter[2]); return true; }
    return false;
  };
  const layers = styleLayers.filter(layer => layer['source-layer'] === sourceLayer);
  return layers.length && layers.every(layer => collect(layer.filter)) ? kinds : null;
}

// A tile with the features of `sourceLayer` whose kind is not in `kinds` left out.
export function strip(tile, sourceLayer, kinds) {
  const out = [];
  for (const field of fields(tile)) {
    if (field.number !== 3) { out.push(tile.subarray(field.start, field.end)); continue; }
    const layer = [...fields(tile, field.content, field.end)];
    if (text(tile, layer.find(f => f.number === 1)) !== sourceLayer) { out.push(tile.subarray(field.start, field.end)); continue; }
    const keys = layer.filter(f => f.number === 3).map(f => text(tile, f));
    const values = layer.filter(f => f.number === 4).map(f => {
      const value = [...fields(tile, f.content, f.end)][0];
      return value?.type === 2 ? text(tile, value) : value?.value;
    });
    const kindOf = feature => {
      const tags = [...fields(tile, feature.content, feature.end)].find(f => f.number === 2);
      if (!tags) return undefined;
      const at = { i: tags.content }, list = [];
      while (at.i < tags.end) list.push(varint(tile, at));
      for (let i = 0; i < list.length; i += 2) if (keys[list[i]] === 'kind') return values[list[i + 1]];
    };
    const kept = layer.filter(f => f.number !== 2 || kinds.has(kindOf(f))).map(f => tile.subarray(f.start, f.end));
    const length = kept.reduce((sum, part) => sum + part.length, 0), head = [];
    encodeVarint(3 << 3 | 2, head);
    encodeVarint(length, head);
    out.push(Uint8Array.from(head), ...kept);
  }
  return Buffer.concat(out);
}

// Directory entries as the spec writes them: ids as differences, then run lengths, lengths, and offsets (0 for one
// right after the entry before, else offset + 1), gzipped.
function directory(entries) {
  const out = [];
  encodeVarint(entries.length, out);
  let last = 0;
  for (const entry of entries) { encodeVarint(entry.tileId - last, out); last = entry.tileId; }
  for (const entry of entries) encodeVarint(entry.runLength, out);
  for (const entry of entries) encodeVarint(entry.length, out);
  entries.forEach((entry, i) => encodeVarint(i > 0 && entry.offset === entries[i - 1].offset + entries[i - 1].length ? 0 : entry.offset + 1, out));
  return gzipSync(Uint8Array.from(out));
}
// The root directory, and leaf directories when the root alone would not fit in the first 16 kB (`rootBytes`).
function directories(entries, rootBytes) {
  const root = directory(entries);
  if (root.length <= rootBytes) return { root, leaves: Buffer.alloc(0) };
  for (let size = Math.min(4096, Math.ceil(entries.length / 8)); ; size *= 2) {
    const leaves = [], rootEntries = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += size) {
      const leaf = directory(entries.slice(i, i + size));
      rootEntries.push({ tileId: entries[i].tileId, offset, length: leaf.length, runLength: 0 });
      leaves.push(leaf);
      offset += leaf.length;
    }
    const root = directory(rootEntries);
    if (root.length <= rootBytes) return { root, leaves: Buffer.concat(leaves) };
  }
}

// Writes an archive of gzipped vector tiles, given in tile id order; tiles with the same bytes are stored once.
export async function writeArchive(target, tiles, { minZoom, maxZoom, bounds: [west, south, east, north], center: [lon, lat, zoom], metadata },
  rootBytes = 16384 - 127) {
  const entries = [], data = [], seen = new Map();
  let dataLength = 0, addressed = 0;
  for await (const { tileId, runLength = 1, tile } of tiles) {
    const hash = createHash('sha256').update(tile).digest('hex');
    addressed += runLength;
    let at = seen.get(hash);
    if (at === undefined) { at = { offset: dataLength, length: tile.length }; seen.set(hash, at); data.push(tile); dataLength += tile.length; }
    const previous = entries.at(-1);
    if (previous && previous.offset === at.offset && previous.tileId + previous.runLength === tileId) previous.runLength += runLength;
    else entries.push({ tileId, offset: at.offset, length: at.length, runLength });
  }
  const meta = gzipSync(JSON.stringify(metadata ?? {}));
  const { root, leaves } = directories(entries, rootBytes);
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'ascii');
  header[7] = 3;
  const sections = [root.length, meta.length, leaves.length, dataLength];
  let offset = 127;
  sections.forEach((length, i) => {
    header.writeBigUInt64LE(BigInt(offset), 8 + i * 16);
    header.writeBigUInt64LE(BigInt(length), 16 + i * 16);
    offset += length;
  });
  [addressed, entries.length, data.length].forEach((value, i) => header.writeBigUInt64LE(BigInt(value), 72 + i * 8));
  // Clustered; gzip inside and for the tiles; vector tiles.
  header.set([1, 2, 2, 1, minZoom, maxZoom], 96);
  [west, south, east, north].forEach((value, i) => header.writeInt32LE(Math.round(value * 1e7), 102 + i * 4));
  header[118] = zoom;
  header.writeInt32LE(Math.round(lon * 1e7), 119);
  header.writeInt32LE(Math.round(lat * 1e7), 123);
  await writeFile(target, Buffer.concat([header, root, meta, leaves, ...data]));
}

// Reads a gzipped vector-tile archive, changes each tile with `change` and writes the result to `target`.
export async function rewrite(source, target, change) {
  const file = await open(source);
  try {
    const archive = new PMTiles({ getKey: () => source, getBytes: async (offset, length) => {
      const data = new Uint8Array(length);
      await file.read(data, 0, length, offset);
      return { data: data.buffer };
    } });
    const header = await archive.getHeader();
    if (header.tileType !== 1 || header.tileCompression !== 2) throw new Error(`${source}: not a gzipped vector-tile archive`);
    async function* tiles(offset, length) {
      for (const entry of await archive.cache.getDirectory(archive.source, offset, length, header)) {
        if (entry.runLength === 0) { yield* tiles(header.leafDirectoryOffset + entry.offset, entry.length); continue; }
        const data = new Uint8Array(entry.length);
        await file.read(data, 0, entry.length, header.tileDataOffset + entry.offset);
        yield { tileId: entry.tileId, runLength: entry.runLength, tile: gzipSync(change(gunzipSync(data)), { level: 9 }) };
      }
    }
    await writeArchive(target, tiles(header.rootDirectoryOffset, header.rootDirectoryLength), {
      minZoom: header.minZoom, maxZoom: header.maxZoom, bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
      center: [header.centerLon, header.centerLat, header.centerZoom], metadata: await archive.getMetadata() });
  } finally {
    await file.close();
  }
}

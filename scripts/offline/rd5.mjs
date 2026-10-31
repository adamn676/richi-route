// BRouter's segment files (.rd5, read by engine/mapaccess/src/files.rs) split into their one-degree squares and joined
// again: a 200-byte index of 25 end offsets (version numbers in each one's top 16 bits), the squares one after the
// other, then a trailer with the creation time, the index's checksum, one checksum per square and the elevation type.
import { crc32 } from 'node:zlib';

// BRouter's checksum is the CRC-32 register without the final inversion.
const crc = bytes => ~crc32(bytes) | 0;
const trailerLength = 8 + 26 * 4 + 1;

// The squares of a file, by index (lon offset * 5 + lat offset), with what joining them needs.
export function split(file) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const ends = Array.from({ length: 25 }, (_, i) => view.getBigInt64(i * 8));
  const end = Number(ends[24] & 0xffff_ffff_ffffn);
  if (file.length !== end + trailerLength) throw new Error('Not a segment file with checksums');
  const header = { versions: ends.map(value => Number(value >> 48n)), created: view.getBigInt64(end), newFormat: (view.getInt32(end + 8) ^ crc(file.subarray(0, 200))) === 2,
    elevationType: file[end + 12 + 25 * 4] };
  if (!header.newFormat && view.getInt32(end + 8) !== crc(file.subarray(0, 200))) throw new Error('Index checksum error');
  const squares = [];
  let start = 200;
  ends.forEach((value, index) => {
    const stop = Number(value & 0xffff_ffff_ffffn);
    if (stop > start) squares.push({ index, checksum: view.getInt32(end + 12 + index * 4), bytes: file.subarray(start, stop) });
    start = stop;
  });
  return { header, squares };
}

// A segment file of the given squares; the others are empty, as in a file at the edge of the map data.
export function join({ header, squares }) {
  const byIndex = new Map(squares.map(square => [square.index, square]));
  const length = 200 + squares.reduce((sum, square) => sum + square.bytes.length, 0);
  const file = new Uint8Array(length + trailerLength), view = new DataView(file.buffer);
  let at = 200;
  for (let index = 0; index < 25; index++) {
    const square = byIndex.get(index);
    if (square) { file.set(square.bytes, at); at += square.bytes.length; }
    view.setBigInt64(index * 8, BigInt(header.versions[index]) << 48n | BigInt(at));
  }
  view.setBigInt64(length, header.created);
  view.setInt32(length + 8, crc(file.subarray(0, 200)) ^ (header.newFormat ? 2 : 0));
  for (let index = 0; index < 25; index++) view.setInt32(length + 12 + index * 4, byIndex.get(index)?.checksum ?? 0);
  file[length + 12 + 25 * 4] = header.elevationType;
  return file;
}

// The file a square belongs to, and the square's own name, from its south-west corner ("E15_N45.rd5", "E16_N47").
export function squareName(index, file) {
  const [, we, lon, sn, lat] = /^([EW])(\d+)_([NS])(\d+)\.rd5$/.exec(file);
  const west = (we === 'E' ? 1 : -1) * +lon + Math.floor(index / 5), south = (sn === 'N' ? 1 : -1) * +lat + index % 5;
  return `${west < 0 ? 'W' : 'E'}${Math.abs(west)}_${south < 0 ? 'S' : 'N'}${Math.abs(south)}`;
}

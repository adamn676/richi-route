import assert from 'node:assert/strict';
import test from 'node:test';
import { join, split, squareName } from '../scripts/offline/rd5.mjs';

const header = { versions: Array.from({ length: 25 }, (_, i) => i === 1 ? 2 : 11), created: 1792205047988n, newFormat: true, elevationType: 1 };
const square = (index, length) => ({ index, checksum: index * 7919 - 40000, bytes: Uint8Array.from({ length }, (_, i) => (i * 31 + index) % 256) });

test('a segment file splits into its squares and joins again unchanged', () => {
  const file = join({ header, squares: [square(0, 50), square(6, 120), square(24, 9)] });
  const parts = split(file);
  assert.deepEqual(parts.header, header);
  assert.deepEqual(parts.squares.map(s => [s.index, s.checksum, s.bytes.length]), [[0, -40000, 50], [6, 7514, 120], [24, 150056, 9]]);
  assert.deepEqual(join(parts), file);
});

test('a file of some squares leaves the others empty', () => {
  const { squares } = split(join({ header, squares: [square(6, 120), square(24, 9)] }));
  assert.deepEqual(squares.map(s => s.index), [6, 24]);
  assert.deepEqual(squares[0].bytes, square(6, 120).bytes);
});

test('a changed index fails its checksum', () => {
  const file = join({ header: { ...header, newFormat: false }, squares: [square(3, 40)] });
  file[8] ^= 1;
  assert.throws(() => split(file), /checksum/);
});

test('squares are named by their south-west corner', () => {
  assert.equal(squareName(0, 'E15_N45.rd5'), 'E15_N45');
  assert.equal(squareName(7, 'E15_N45.rd5'), 'E16_N47');
  assert.equal(squareName(24, 'W5_N45.rd5'), 'W1_N49');
  assert.equal(squareName(0, 'W5_S5.rd5'), 'W5_S5');
});

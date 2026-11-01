import assert from 'node:assert/strict';
import test from 'node:test';
import { flowingDashes, runningLight } from '../src/utils/line-flow.ts';

test('flowing dashes keep their period and move the dash along', () => {
  const patterns = flowingDashes(1, 1.6, 13);
  assert.equal(patterns.length, 13);
  assert.deepEqual(patterns[0], [0, 0, 1, 1.6]);
  for (const pattern of patterns) assert.ok(Math.abs(pattern.reduce((sum, part) => sum + part, 0) - 2.6) < 1e-9, String(pattern));
  // Where the dash starts moves forward step by step, wrapping once round the period.
  const starts = patterns.map(([first, gap]) => first > 0 ? 0 : gap);
  assert.deepEqual(starts.slice(0, 3), [0, .2, .4]);
});

test('the running light moves from the start to beyond the end', () => {
  const positions = phase => runningLight(phase).slice(3).filter((_, i) => i % 2 === 0);
  for (const phase of [0, .3, 1]) {
    const stops = positions(phase);
    assert.ok(stops.every((stop, i) => i === 0 || stop > stops[i - 1]), String(stops));
  }
  // The head starts at the line's start; at the end even the tail has left it.
  assert.ok(Math.abs(positions(0)[3]) < 1e-9);
  assert.ok(positions(1)[0] >= 1);
});

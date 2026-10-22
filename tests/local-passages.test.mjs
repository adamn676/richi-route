import test from 'node:test';
import assert from 'node:assert/strict';
import { usesWeidwegPassage } from '../src/domain/local-passages.ts';

const a = [15.397866, 47.10255], b = [15.397832, 47.102537];
const middle = a.map((n, i) => (n + b[i]) / 2);
test('Weidweg notice covers forward, reverse and partial stair flights', () => {
  for (const coordinates of [[a, b], [b, a], [middle, b], [a, middle], [[15.397639, 47.102476], [15.397607, 47.102466]]]) {
    assert.ok(usesWeidwegPassage([{ coordinates }]));
  }
});
test('Weidweg notice excludes nearby roads, a crossing line and stationary points', () => {
  for (const coordinates of [[a, a], [[15.397866, 47.10256], [15.397832, 47.102547]], [[15.3979, 47.1026], [15.3976, 47.1024]]]) {
    assert.equal(usesWeidwegPassage([{ coordinates }]), false);
  }
  assert.equal(usesWeidwegPassage([]), false);
});

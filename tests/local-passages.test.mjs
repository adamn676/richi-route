import test from 'node:test';
import assert from 'node:assert/strict';
import { localRoutingNotices, createNoticeIndex } from '../src/domain/local-routing-notices.ts';

const a = [15.397866, 47.10255], b = [15.397832, 47.102537];
const middle = a.map((n, i) => (n + b[i]) / 2);
test('Weidweg notice covers forward, reverse and partial stair flights', () => {
  for (const coordinates of [[a, b], [b, a], [middle, b], [a, middle], [[15.397639, 47.102476], [15.397607, 47.102466]]]) {
    assert.deepEqual(localRoutingNotices([{ coordinates }]).map(n => n.id), ['weidweg-push-through']);
  }
});
test('Weidweg notice excludes nearby roads, a crossing line and stationary points', () => {
  for (const coordinates of [[a, a], [[15.397866, 47.10256], [15.397832, 47.102547]], [[15.3979, 47.1026], [15.3976, 47.1024]]]) {
    assert.deepEqual(localRoutingNotices([{ coordinates }]), []);
  }
  assert.deepEqual(localRoutingNotices([]), []);
});

test('notices support additional locations, direction, partial segments and deduplication', () => {
  const match = createNoticeIndex([
    { id: 'first', text: 'First passage', direction: 'forward', segments: [[a, b]] },
    { id: 'second', text: 'Second passage', direction: 'both', segments: [[[16, 48], [16.001, 48.001]]] },
  ]);
  assert.deepEqual(match([{ coordinates: [b, a] }]), []);
  assert.deepEqual(match([{ coordinates: [a, middle, b, a] }, { coordinates: [[16, 48], [16.001, 48.001]] }]), [
    { id: 'first', text: 'First passage' }, { id: 'second', text: 'Second passage' },
  ]);
  assert.deepEqual(createNoticeIndex([])([{ coordinates: [a, b] }]), []);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assessReviewedRoute, geometryHash } from '../reviewed-routes.mjs';

test('reviewed fixtures cover all twelve cases without claiming the composite is already automatic', async () => {
  const suite = JSON.parse(await readFile(new URL('../fixtures/reviewed-routes.json', import.meta.url), 'utf8'));
  assert.equal(new Set(suite.routes.map(r => r.caseId)).size, 12);
  assert.equal(new Set(suite.routes.map(r => r.id)).size, suite.routes.length);
  assert.deepEqual(suite.routes.filter(r => r.expectation === 'target').map(r => r.caseId), ['11-western-loop']);
  for (const reference of suite.routes) {
    assert.equal(geometryHash(reference.coordinates), reference.geometrySha256, reference.id);
    assert.ok(reference.source.feedback && reference.source.note);
    assert.equal(assessReviewedRoute(reference, reference.coordinates).matches, true, reference.id);
  }
});

const a = [15.4, 47.1], b = [15.401, 47.1], c = [15.402, 47.1];
const reference = { coordinates: [a, b, c, b, a], points: [a, b, c, b, a].map(coord => ({ role: 'stop', coord })) };

test('an out-and-back regression cannot pass with the same footprint but a missing return or added backtracking', () => {
  assert.equal(assessReviewedRoute(reference, [a, b, c]).matches, false);
  assert.equal(assessReviewedRoute(reference, [a, b, c, b, a, b, a]).matches, false);
  assert.equal(assessReviewedRoute(reference, [a, b, c, b, a]).matches, true);
});

test('repeated waypoint visits must occur in order even when distance and footprint agree', () => {
  const d = [15.401, 47.101];
  const ordered = { coordinates: [a, b, c, b, d, b, a], points: [a, c, d, a].map(coord => ({ role: 'stop', coord })) };
  const assessment = assessReviewedRoute(ordered, [a, b, d, b, c, b, a]);
  assert.equal(assessment.matches, false);
  assert.equal(assessment.waypoints[2].visitedInOrder, false);
});

test('a nearby parallel road and reversed endpoints do not match the accepted route', () => {
  const line = { coordinates: [a, b, c], points: [a, c].map(coord => ({ role: 'stop', coord })) };
  assert.equal(assessReviewedRoute(line, [c, b, a]).matches, false);
  assert.equal(assessReviewedRoute(line, [a, [15.401, 47.10006], c]).matches, false);
});

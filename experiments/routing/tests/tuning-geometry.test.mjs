import test from 'node:test';
import assert from 'node:assert/strict';
import { compareGeometry, referenceFromSegments } from '../tuning-geometry.mjs';

const line = [[15.4,47.07],[15.401,47.07],[15.402,47.07]];
test('geometry comparison accepts resampling but detects a parallel path and backtracking', () => {
  const resampled = compareGeometry([line[0],[15.4005,47.07],line[1],line[2]],line);
  assert.ok(resampled.maximumSampledSeparationM < 0.001);
  const parallel = compareGeometry(line.map(([x,y]) => [x,y+0.0001]),line);
  assert.ok(parallel.maximumSampledSeparationM > 10);
  assert.ok(parallel.candidateOutside3mM > 150);
  const backtrack = compareGeometry([line[0],line[1],line[0],line[1],line[2]],line);
  assert.ok(backtrack.lengthDifferenceM > 150);
  const reversed = compareGeometry([...line].reverse(),line);
  assert.ok(reversed.startSeparationM > 150);
});

test('composite references retain segment provenance and reject invented connectors', () => {
  const run={id:'saved',results:[{id:'br',caseId:'case',variant:'selected',points:line.map(coord=>({coord})),normalized:{geometry:{coordinates:line}}},{id:'gh',caseId:'case',variant:'selected',points:line.map(coord=>({coord})),normalized:{geometry:{coordinates:line}}}]};
  const feedback={runId:'saved',caseId:'case',variant:'selected',referenceSegments:[{resultId:'br',fromPoint:1,throughPoint:2},{resultId:'gh',fromPoint:2,throughPoint:3}]};
  const reference=referenceFromSegments(run,feedback);
  assert.deepEqual(reference.properties.sources.map(s=>s.resultId),['br','gh']);
  assert.deepEqual(reference.geometry.coordinates,[line[0],line[1],line[1],line[2]]);
  assert.throws(()=>referenceFromSegments(run,{...feedback,runId:'wrong'}),/identify/);
  run.results[1].normalized.geometry.coordinates=line.map(([x,y])=>[x,y+0.001]);
  assert.throws(()=>referenceFromSegments(run,feedback),/shaping point/);
});

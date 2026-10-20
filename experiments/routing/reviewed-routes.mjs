import { createHash } from 'node:crypto';
import { distanceM } from './engines.mjs';
import { compareGeometry } from './tuning-geometry.mjs';

export const geometryHash = coordinates => createHash('sha256').update(JSON.stringify(coordinates)).digest('hex');

export function assessReviewedRoute(reference, candidate) {
  const expected = reference.coordinates;
  const actual = candidate.map(c => c.slice(0, 2));
  const geometry = compareGeometry(actual, expected);
  let expectedIndex = 0, actualIndex = 0;
  const waypoints = reference.points.map((point, i) => {
    if (i === reference.points.length - 1) expectedIndex = expected.length - 1;
    else if (i > 0) {
      let nearest = expectedIndex + 1;
      for (let j = nearest; j < expected.length; j++) {
        if (distanceM(expected[j], point.coord) < distanceM(expected[nearest], point.coord)) nearest = j;
      }
      expectedIndex = nearest;
    }
    const snapped = expected[expectedIndex];
    let match;
    if (i === 0) match = distanceM(actual[0], snapped) <= 1 ? 0 : -1;
    else if (i === reference.points.length - 1) match = distanceM(actual.at(-1), snapped) <= 1 && actual.length - 1 > actualIndex ? actual.length - 1 : -1;
    else match = actual.findIndex((coord, j) => j > actualIndex && distanceM(coord, snapped) <= 1);
    if (match >= 0) actualIndex = match;
    return { point: i + 1, visitedInOrder: match >= 0 };
  });
  const matches = geometry.maximumSampledSeparationM <= 1 &&
    Math.abs(geometry.lengthDifferenceM) <= 2 &&
    geometry.startSeparationM <= 1 && geometry.endSeparationM <= 1 &&
    waypoints.every(point => point.visitedInOrder);
  return { matches, geometry, waypoints };
}

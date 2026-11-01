import { cumulativeAscent, distanceMeters, routerClimbThreshold, type LegGeometry } from './route-model.ts';
import { clipSpans, sectionCuts } from './gpx-route.ts';
import { routingPolicyVersion } from '../config/routing-policy.ts';

// A distance and climbing for the routing service's loop suggestions (engine/planner).
export interface LoopTarget { meters: number; ascent: number }

// A chosen loop becomes a route like an opened GPX track: sections of about 5 km between shaping points, each with
// its heights, surfaces and share of the climbing, so the totals stay those of the suggestion.
export function loopSections(leg: LegGeometry): LegGeometry[] {
  const distances = [0];
  for (let i = 1; i < leg.coordinates.length; i++) distances.push(distances[i - 1] + distanceMeters(leg.coordinates[i - 1], leg.coordinates[i]));
  const scale = distances.at(-1) ? leg.distanceMeters / distances.at(-1)! : 0;
  const climbed = leg.elevations && cumulativeAscent(leg.elevations, routerClimbThreshold);
  const cuts = sectionCuts(distances);
  return cuts.slice(1).map((to, k) => {
    const from = cuts[k];
    return { coordinates: leg.coordinates.slice(from, to + 1), elevations: leg.elevations?.slice(from, to + 1) ?? null,
      distanceMeters: (distances[to] - distances[from]) * scale, ascentMeters: climbed && climbed[to] - climbed[from],
      surfaces: clipSpans(leg.surfaces, from, to), routingPolicy: routingPolicyVersion };
  });
}

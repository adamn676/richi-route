import { cumulativeAscent, distanceMeters, pathMeters, routerClimbThreshold, sameKind, spanKind, type Coord, type LegGeometry, type SurfaceSpan } from './route-model.ts';
import { bearing } from './gpx-inspection.ts';
import { clipSpans, sectionCuts } from './gpx-route.ts';
import { routingPolicyVersion } from '../config/routing-policy.ts';

export interface LoopTarget { meters: number; ascent: number }
export interface LoopCandidate { direction: number; radius: number; leg: LegGeometry }

// BRouter builds a loop through five points on a circle; it comes out about 6.2 times the circle's radius.
// Twelve directions give loops through different country, so climbing differs much more than distance.
export const loopDirections = Array.from({ length: 12 }, (_, i) => i * 30);
export const firstRadius = (meters: number) => meters / 6.2;
// The second try in each direction scales the radius by how far the first missed the distance; the third aims
// between both tries, as distance grows with the radius but not in proportion.
export const correctedRadius = ({ radius, leg }: LoopCandidate, meters: number) =>
  radius * Math.min(2, Math.max(.5, meters / leg.distanceMeters));
export function refinedRadius(first: LoopCandidate, second: LoopCandidate, meters: number) {
  const slope = (second.leg.distanceMeters - first.leg.distanceMeters) / (second.radius - first.radius);
  if (!(slope > 0)) return correctedRadius(second, meters);
  return Math.min(second.radius * 2, Math.max(second.radius / 2, second.radius + (meters - second.leg.distanceMeters) / slope));
}

// A loop without its dead ends. BRouter snaps each of its circle points to the nearest road, and when that road is a
// dead end the loop rides in, perhaps round a turning circle, and back out. Whenever the loop returns to a point it
// passed less than 1 km before, the stretch in between goes; a dead end of any length unwinds point by point, while
// the road from home that a loop starts and ends on stays. Heights, surfaces, distance and climbing follow.
export function withoutSpurs(leg: LegGeometry): LegGeometry {
  const kept: number[] = [], along: number[] = [], position = new Map<string, number>();
  for (let i = 0; i < leg.coordinates.length; i++) {
    const key = String(leg.coordinates[i]), earlier = position.get(key);
    const here = kept.length ? along.at(-1)! + distanceMeters(leg.coordinates[kept.at(-1)!], leg.coordinates[i]) : 0;
    // The return home at the very end closes the loop; it is never a dead end.
    if (earlier !== undefined && i < leg.coordinates.length - 1 && here - along[earlier] < 1000) {
      while (kept.length > earlier + 1) {
        const dropped = String(leg.coordinates[kept.pop()!]);
        if (position.get(dropped) === kept.length) position.delete(dropped);
        along.pop();
      }
      continue;
    }
    position.set(key, kept.length);
    kept.push(i);
    along.push(here);
  }
  if (kept.length === leg.coordinates.length || kept.length < 2) return leg;
  const coordinates = kept.map(i => leg.coordinates[i]);
  const elevations = leg.elevations && kept.map(i => leg.elevations![i]);
  // Each kept step is the original step that arrived at its end point.
  const spanOf: (SurfaceSpan | undefined)[] = [];
  for (const span of leg.surfaces) for (let k = span.fromIndex; k < span.toIndex; k++) spanOf[k] = span;
  const surfaces: SurfaceSpan[] = [];
  for (let j = 0; j < kept.length - 1; j++) {
    const span = spanOf[kept[j + 1] - 1], previous = surfaces.at(-1);
    if (!span) continue;
    if (previous?.toIndex === j && sameKind(previous, span)) previous.toIndex = j + 1;
    else surfaces.push({ fromIndex: j, toIndex: j + 1, ...spanKind(span) });
  }
  return { ...leg, coordinates, elevations, surfaces, distanceMeters: leg.distanceMeters * pathMeters(coordinates) / pathMeters(leg.coordinates),
    ascentMeters: elevations ? cumulativeAscent(elevations, routerClimbThreshold).at(-1)! : leg.ascentMeters };
}

// The share of a loop on roads ridden both ways, out and back.
export function twiceShare({ coordinates }: LegGeometry): number {
  const steps = new Set<string>();
  for (let i = 1; i < coordinates.length; i++) steps.add(`${coordinates[i - 1]}|${coordinates[i]}`);
  let twice = 0, total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const length = distanceMeters(coordinates[i - 1], coordinates[i]);
    total += length;
    if (steps.has(`${coordinates[i]}|${coordinates[i - 1]}`)) twice += length;
  }
  return total ? twice / total : 0;
}

const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

// Distance counts most, and a loop more than 15% off only fills in; then climbing. Roads ridden twice make a loop
// worse. Of the best, those heading at least 60° apart, so the suggestions differ.
export function pickLoops(candidates: LoopCandidate[], target: LoopTarget, count = 3): LoopCandidate[] {
  const score = ({ leg }: LoopCandidate) => {
    const distance = Math.abs(leg.distanceMeters - target.meters) / target.meters;
    return 2 * distance + (distance > .15 ? 1 : 0) + Math.abs((leg.ascentMeters ?? 0) - target.ascent) / Math.max(target.ascent, 200) +
      4 * twiceShare(leg);
  };
  const scores = new Map(candidates.map(candidate => [candidate, score(candidate)]));
  const picks: LoopCandidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => scores.get(a)! - scores.get(b)!)) {
    if (picks.every(pick => apart(pick.direction, candidate.direction) >= 60)) picks.push(candidate);
    if (picks.length === count) break;
  }
  return picks;
}

export function farthestPoint({ coordinates }: LegGeometry, start: Coord): Coord {
  return coordinates.reduce((far, coord) => distanceMeters(start, coord) > distanceMeters(start, far) ? coord : far, start);
}

// Points spread evenly along a loop, leaving out its start and end.
export function pointsAlong({ coordinates }: LegGeometry, count: number): Coord[] {
  const distances = [0];
  for (let i = 1; i < coordinates.length; i++) distances.push(distances[i - 1] + distanceMeters(coordinates[i - 1], coordinates[i]));
  const points: Coord[] = [];
  for (let k = 1, i = 0; k <= count; k++) {
    while (i < coordinates.length - 1 && distances[i] < distances.at(-1)! * k / (count + 1)) i++;
    points.push(coordinates[i]);
  }
  return points;
}

const compass = ['Norden', 'Nordosten', 'Osten', 'Südosten', 'Süden', 'Südwesten', 'Westen', 'Nordwesten'];
export const compassName = (from: Coord, to: Coord) => compass[Math.round(bearing(from, to) / 45) % 8];

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

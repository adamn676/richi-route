import { cumulativeAscent, distanceMeters, pathMeters, routerClimbThreshold, sameKind, spanKind, type Coord, type LegGeometry, type SurfaceSpan } from './route-model.ts';
import { bearing } from './gpx-inspection.ts';
import { clipSpans, sectionCuts } from './gpx-route.ts';
import { routingPolicyVersion } from '../config/routing-policy.ts';

export interface LoopTarget { meters: number; ascent: number }
// `points` is how many points on its arc BRouter routes a loop through: fewer make it narrower, more rounder. With one
// point it is a ride out and back, `direction` the bearing and `radius` the distance to where it turns.
export interface LoopCandidate { direction: number; radius: number; points: number; leg: LegGeometry }

// BRouter builds a loop through points on an arc around the start; with five it comes out about 6.2 times the radius.
// Twelve directions give loops through different country, so climbing differs much more than distance; `turn` turns
// them all, so that each search heads out a little differently.
export const loopDirections = (turn = 0) => Array.from({ length: 12 }, (_, i) => i * 30 + turn);
export const loopShapes = [5, 4, 6];
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

const metersOn = ({ coordinates, surfaces }: LegGeometry, kinds: SurfaceSpan['surface'][]) => surfaces
  .reduce((sum, span) => kinds.includes(span.surface) ? sum + pathMeters(coordinates.slice(span.fromIndex, span.toIndex + 1)) : sum, 0);

// The share of a loop on unpaved roads.
export function unpavedShare(leg: LegGeometry): number {
  const total = pathMeters(leg.coordinates);
  return total ? metersOn(leg, ['unpaved']) / total : 0;
}

// A road bike stays on paved roads: a suggestion leaves them for at most 500 m, or 1 % of a long one. Ways of unknown
// surface count as unpaved here; most are paths and tracks.
export function rideable(leg: LegGeometry): boolean {
  return metersOn(leg, ['unpaved', 'unknown']) <= Math.max(500, pathMeters(leg.coordinates) * .01);
}

const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
// A ride out and back weighs as much as missing the distance by half: worse than a good loop, better than a poor one.
const outAndBack = 1;

// Distance counts most, and a loop more than 15% off only fills in; then climbing. Roads ridden twice make a loop
// worse, and unpaved roads, which a loop meets where BRouter snaps a circle point to a track, much worse: 10 % of a
// loop unpaved weighs as much as missing the distance by 15 %. A ride out and back counts as `outAndBack`.
export function loopQuality({ leg, points }: LoopCandidate, target: LoopTarget): number {
  const distance = Math.abs(leg.distanceMeters - target.meters) / target.meters;
  return 2 * distance + (distance > .15 ? 1 : 0) + Math.abs((leg.ascentMeters ?? 0) - target.ascent) / Math.max(target.ascent, 200) +
    (points === 1 ? outAndBack : 4 * twiceShare(leg)) + 10 * unpavedShare(leg);
}

// Rides out and back are worth trying where the loops found fall short of one.
export const wantsOutAndBack = (picks: LoopCandidate[], target: LoopTarget, count = 3) =>
  picks.length < count || picks.some(pick => loopQuality(pick, target) > outAndBack);

// Only rideable loops within half the distance. Among those nearly as good as the best and with hardly more unpaved road, those on roads
// suggested lately (`seen`, from 0 to 1) come last, so the suggestions change from one search to the next; a worse loop
// never wins by being new, it only fills in. Of these, loops heading at least 60° apart, so the suggestions differ;
// rides out and back share the valley road with others, so they need only differ in more than half their squares (`cells`).
export function pickLoops(candidates: LoopCandidate[], target: LoopTarget, count = 3,
  seen: (candidate: LoopCandidate) => number = () => 0, cells?: (candidate: LoopCandidate) => string[]): LoopCandidate[] {
  candidates = candidates.filter(({ leg }) => rideable(leg) && Math.abs(leg.distanceMeters - target.meters) <= target.meters / 2);
  if (!candidates.length) return [];
  const qualities = new Map(candidates.map(candidate => [candidate, loopQuality(candidate, target)]));
  const best = candidates.reduce((a, b) => qualities.get(b)! < qualities.get(a)! ? b : a);
  const unpavedAtBest = unpavedShare(best.leg);
  const scores = new Map(candidates.map(candidate => {
    const own = qualities.get(candidate)!;
    const asGood = own <= qualities.get(best)! + .25 && unpavedShare(candidate.leg) <= unpavedAtBest + .005;
    return [candidate, asGood ? own + seen(candidate) : 100 + own];
  }));
  const differ = (a: LoopCandidate, b: LoopCandidate) => cells && (a.points === 1 || b.points === 1)
    ? seenShare(cells(a), [{ cells: cells(b), weight: 1 }]) <= .5 : apart(a.direction, b.direction) >= 60;
  const picks: LoopCandidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => scores.get(a)! - scores.get(b)!)) {
    if (picks.every(pick => differ(candidate, pick))) picks.push(candidate);
    if (picks.length === count) break;
  }
  return picks;
}

// Where a ride out and back could turn: on each loop's paved way out, and its way home ridden backwards, half the
// distance from home; a paved way ending before that, at least a sixth of it out, turns at its end. Turns within 1 km of
// another are one.
export function turnPoints(legs: LegGeometry[], meters: number): Coord[] {
  const turns: Coord[] = [];
  for (const leg of legs) for (const way of [pavedWay(leg, false), pavedWay(leg, true)]) {
    const length = way.along.at(-1)!, half = meters / 2;
    if (length < meters / 6) continue;
    const i = way.along.findIndex(along => along >= half);
    let turn = way.coordinates.at(-1)!;
    if (i > 0) {
      const share = (half - way.along[i - 1]) / (way.along[i] - way.along[i - 1]), [a, b] = [way.coordinates[i - 1], way.coordinates[i]];
      turn = [a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share];
    }
    if (turns.every(other => distanceMeters(other, turn) >= 1000)) turns.push(turn);
  }
  return turns;
}

// The start of a loop, or of its way home ridden backwards (`backwards`), as far as it stays on paved roads: it ends
// before the first stretch of more than 200 m unpaved or of unknown surface.
function pavedWay(leg: LegGeometry, backwards: boolean): { coordinates: Coord[]; along: number[] } {
  const steps = leg.coordinates.length - 1, rough: boolean[] = [];
  for (const span of leg.surfaces) for (let k = span.fromIndex; k < span.toIndex; k++) rough[k] = span.surface === 'unpaved' || span.surface === 'unknown';
  const coordinates = [backwards ? leg.coordinates[steps] : leg.coordinates[0]], along = [0];
  let off = 0, end = 1;
  for (let j = 0; j < steps; j++) {
    const k = backwards ? steps - 1 - j : j, to = leg.coordinates[backwards ? k : k + 1];
    const step = distanceMeters(coordinates.at(-1)!, to);
    off = rough[k] ? off + step : 0;
    if (off > 200) break;
    coordinates.push(to);
    along.push(along.at(-1)! + step);
    if (!rough[k]) end = coordinates.length;
  }
  return { coordinates: coordinates.slice(0, end), along: along.slice(0, end) };
}

// The squares of about 250 m a loop passes through, counted every 100 m, leaving out those within `near` metres of the
// start, which every loop from there shares.
export function loopCells({ coordinates }: LegGeometry, start: Coord, near: number): string[] {
  const size = 250, north = size / 111195, east = size / (111320 * Math.cos(start[1] * Math.PI / 180));
  const cells = new Set<string>();
  const visit = (coord: Coord) => {
    if (distanceMeters(start, coord) >= near) cells.add(`${Math.floor(coord[0] / east)},${Math.floor(coord[1] / north)}`);
  };
  coordinates.forEach((coord, i) => {
    if (i) {
      const from = coordinates[i - 1], steps = Math.floor(distanceMeters(from, coord) / 100);
      for (let k = 1; k <= steps; k++) visit([from[0] + (coord[0] - from[0]) * k / (steps + 1), from[1] + (coord[1] - from[1]) * k / (steps + 1)]);
    }
    visit(coord);
  });
  return [...cells];
}

// How much of a loop's squares an earlier suggestion already went through, each earlier one weighted by how recent it
// is: the largest weighted share, from 0 to 1.
export function seenShare(cells: string[], earlier: { cells: string[]; weight: number }[]): number {
  if (!cells.length) return 0;
  return Math.max(0, ...earlier.map(({ cells: before, weight }) => {
    const passed = new Set(before);
    return weight * cells.filter(cell => passed.has(cell)).length / cells.length;
  }));
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

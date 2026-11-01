import type { Coord, LegGeometry } from '../domain/route-model.ts';
import { distanceMeters } from '../domain/route-model.ts';
import { bearing } from '../domain/gpx-inspection.ts';
import { compassName, correctedRadius, farthestPoint, firstRadius, loopCells, loopDirections, loopShapes, pickLoops, pointsAlong,
  refinedRadius, seenShare, turnPoints, wantsOutAndBack, withoutSpurs, type LoopCandidate, type LoopTarget } from '../domain/loop-suggestions.ts';
import { traceRoundTrip, traceThereAndBack } from './route.service.ts';
import { townAt } from './geocoding.service.ts';

// `cells` are the squares a loop passes through, for later searches to avoid (loopCells); `back` marks a ride out and back.
export interface LoopSuggestion { leg: LegGeometry; heading: string; place?: string; cells: string[]; back: boolean }
// The routing and town lookups, replaceable for tests; loops suggested before from the same start, each weighted by how
// recent it is; and the dice.
export interface LoopSearch {
  trace?: typeof traceRoundTrip; thereAndBack?: typeof traceThereAndBack; town?: typeof townAt;
  earlier?: { cells: string[]; weight: number }[]; random?: () => number;
}

// Loops in twelve directions without their dead ends, each tried three times to hit the distance. Each search turns
// the directions by a random angle and gives each a random shape, and roads suggested lately count against a loop, so
// that asking again brings other loops of the same quality. Where the loops fall short, as in a valley closed by
// mountains, rides out and back along the paved roads the loops head out on join them. The three that fit best and
// differ are named by where they lead. A direction without a loop (no roads, no map data) is left out.
export async function suggestLoops(start: Coord, target: LoopTarget, signal: AbortSignal,
  { trace = traceRoundTrip, thereAndBack = traceThereAndBack, town = townAt, earlier = [], random = Math.random }: LoopSearch = {}): Promise<LoopSuggestion[]> {
  let failure: unknown;
  const found = async (route: () => Promise<LoopCandidate>) => {
    try { return await route(); }
    catch (error) { signal.throwIfAborted(); failure ??= error; return null; }
  };
  const loops = async (tries: [number, number, number][]) => (await Promise.all(tries.map(([direction, radius, points]) =>
    found(async () => ({ direction, radius, points, leg: withoutSpurs(await trace(start, radius, direction, signal, points)) })))))
    .filter((candidate): candidate is LoopCandidate => candidate !== null);
  const turn = Math.floor(random() * 30);
  const first = await loops(loopDirections(turn).map(direction =>
    [direction, firstRadius(target.meters), loopShapes[Math.floor(random() * loopShapes.length)]]));
  // Without a single loop the routing service itself failed; its message says why.
  if (!first.length) throw failure;
  const second = await loops(first.map(candidate => [candidate.direction, correctedRadius(candidate, target.meters), candidate.points]));
  const third = await loops(second.map(candidate => [candidate.direction,
    refinedRadius(first.find(before => before.direction === candidate.direction)!, candidate, target.meters), candidate.points]));
  // The roads near home are every loop's; only those beyond tell loops apart.
  const candidates = [...first, ...second, ...third], near = Math.min(3000, target.meters * .08), squares = new Map<LoopCandidate, string[]>();
  const cells = (candidate: LoopCandidate) => squares.get(candidate) ?? squares.set(candidate, loopCells(candidate.leg, start, near)).get(candidate)!;
  const pick = () => pickLoops(candidates, target, 3, candidate => seenShare(cells(candidate), earlier), cells);
  let picks = pick();
  if (wantsOutAndBack(picks, target)) {
    const backs = await Promise.all(turnPoints(candidates.map(candidate => candidate.leg), target.meters).map(point =>
      found(async () => ({ direction: bearing(start, point), radius: distanceMeters(start, point), points: 1, leg: await thereAndBack(start, point, signal) }))));
    candidates.push(...backs.filter((candidate): candidate is LoopCandidate => candidate !== null));
    picks = pick();
  }
  return (await name(picks, start, signal, town)).map((suggestion, i) => ({ ...suggestion, cells: cells(picks[i]), back: picks[i].points === 1 }));
}

// A loop is named after the town it passes most, a ride out and back after the town it turns in, other than the start's
// own and those naming an earlier suggestion; without one, its compass direction says where it goes.
async function name(picks: LoopCandidate[], start: Coord, signal: AbortSignal, town: typeof townAt): Promise<Omit<LoopSuggestion, 'cells' | 'back'>[]> {
  const lookup = (coord: Coord) => town(coord, signal).catch(() => undefined);
  // A ride out and back turns halfway; in a winding valley that may lie nearer home than other points.
  const far = picks.map(pick => pick.points === 1 ? pointsAlong(pick.leg, 1)[0] : farthestPoint(pick.leg, start));
  const [home, ...along] = await Promise.all([lookup(start), ...picks.map((pick, i) =>
    Promise.all(pick.points === 1 ? [lookup(far[i])] : pointsAlong(pick.leg, 8).map(lookup)))]);
  const used = new Set([home]);
  return picks.map((pick, i) => {
    const counts = new Map<string, number>();
    for (const found of along[i]) if (found && !used.has(found)) counts.set(found, (counts.get(found) ?? 0) + 1);
    const place = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    used.add(place);
    return { leg: pick.leg, heading: compassName(start, far[i]), place };
  });
}

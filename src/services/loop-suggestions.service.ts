import type { Coord, LegGeometry } from '../domain/route-model.ts';
import { compassName, correctedRadius, farthestPoint, firstRadius, loopCells, loopDirections, loopShapes, pickLoops, pointsAlong,
  refinedRadius, seenShare, withoutSpurs, type LoopCandidate, type LoopTarget } from '../domain/loop-suggestions.ts';
import { traceRoundTrip } from './route.service.ts';
import { townAt } from './geocoding.service.ts';

// `cells` are the squares a loop passes through, for later searches to avoid (loopCells).
export interface LoopSuggestion { leg: LegGeometry; heading: string; place?: string; cells: string[] }
// Loops suggested before from the same start, each weighted by how recent it is; and the dice.
export interface LoopVariety { earlier?: { cells: string[]; weight: number }[]; random?: () => number }

// Loops in twelve directions without their dead ends, each tried three times to hit the distance. Each search turns
// the directions by a random angle and gives each a random shape, and roads suggested lately count against a loop, so
// that asking again brings other loops of the same quality. The three that fit best and head apart are named by where
// they lead. A direction without a loop (no roads, no map data) is left out.
export async function suggestLoops(start: Coord, target: LoopTarget, signal: AbortSignal,
  trace = traceRoundTrip, town = townAt, { earlier = [], random = Math.random }: LoopVariety = {}): Promise<LoopSuggestion[]> {
  let failure: unknown;
  const attempt = async (direction: number, radius: number, points: number): Promise<LoopCandidate | null> => {
    try { return { direction, radius, points, leg: withoutSpurs(await trace(start, radius, direction, signal, points)) }; }
    catch (error) { signal.throwIfAborted(); failure ??= error; return null; }
  };
  const loops = async (tries: [number, number, number][]) => (await Promise.all(tries.map(([direction, radius, points]) => attempt(direction, radius, points))))
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
  const candidates = [...first, ...second, ...third], near = Math.min(3000, target.meters * .08);
  const cells = new Map(candidates.map(candidate => [candidate, loopCells(candidate.leg, start, near)]));
  const picks = pickLoops(candidates, target, 3, candidate => seenShare(cells.get(candidate)!, earlier));
  return (await name(picks, start, signal, town)).map((suggestion, i) => ({ ...suggestion, cells: cells.get(picks[i])! }));
}

// A loop is named after the town it passes most, other than the start's own and those naming an earlier loop;
// without one, its compass direction says where it goes.
async function name(picks: LoopCandidate[], start: Coord, signal: AbortSignal, town: typeof townAt): Promise<Omit<LoopSuggestion, 'cells'>[]> {
  const lookup = (coord: Coord) => town(coord, signal).catch(() => undefined);
  const [home, ...along] = await Promise.all([lookup(start), ...picks.map(pick => Promise.all(pointsAlong(pick.leg, 8).map(lookup)))]);
  const used = new Set([home]);
  return picks.map((pick, i) => {
    const counts = new Map<string, number>();
    for (const found of along[i]) if (found && !used.has(found)) counts.set(found, (counts.get(found) ?? 0) + 1);
    const place = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    used.add(place);
    return { leg: pick.leg, heading: compassName(start, farthestPoint(pick.leg, start)), place };
  });
}

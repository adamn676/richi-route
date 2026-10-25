import type { Coord, LegGeometry } from '../domain/route-model.ts';
import { compassName, correctedRadius, farthestPoint, firstRadius, loopDirections, pickLoops, pointsAlong, refinedRadius,
  withoutSpurs, type LoopCandidate, type LoopTarget } from '../domain/loop-suggestions.ts';
import { traceRoundTrip } from './route.service.ts';
import { townAt } from './geocoding.service.ts';

export interface LoopSuggestion { leg: LegGeometry; heading: string; place?: string }

// Loops in twelve directions without their dead ends, each tried three times to hit the distance; the three that
// fit best and head apart are named by where they lead. A direction without a loop (no roads, no map data) is left out.
export async function suggestLoops(start: Coord, target: LoopTarget, signal: AbortSignal,
  trace = traceRoundTrip, town = townAt): Promise<LoopSuggestion[]> {
  let failure: unknown;
  const attempt = async (direction: number, radius: number): Promise<LoopCandidate | null> => {
    try { return { direction, radius, leg: withoutSpurs(await trace(start, radius, direction, signal)) }; }
    catch (error) { signal.throwIfAborted(); failure ??= error; return null; }
  };
  const loops = async (tries: [number, number][]) => (await Promise.all(tries.map(([direction, radius]) => attempt(direction, radius))))
    .filter((candidate): candidate is LoopCandidate => candidate !== null);
  const first = await loops(loopDirections.map(direction => [direction, firstRadius(target.meters)]));
  // Without a single loop the routing service itself failed; its message says why.
  if (!first.length) throw failure;
  const second = await loops(first.map(candidate => [candidate.direction, correctedRadius(candidate, target.meters)]));
  const third = await loops(second.map(candidate => [candidate.direction,
    refinedRadius(first.find(earlier => earlier.direction === candidate.direction)!, candidate, target.meters)]));
  const picks = pickLoops([...first, ...second, ...third], target);
  return name(picks, start, signal, town);
}

// A loop is named after the town it passes most, other than the start's own and those naming an earlier loop;
// without one, its compass direction says where it goes.
async function name(picks: LoopCandidate[], start: Coord, signal: AbortSignal, town: typeof townAt): Promise<LoopSuggestion[]> {
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

import type { Coord, LegGeometry } from '../domain/route-model.ts';
import type { LoopTarget } from '../domain/loop-suggestions.ts';
import { traceLoops } from './route.service.ts';
import { townAt } from './geocoding.service.ts';

// `cells` are the squares a loop passes through, for later searches to avoid; `back` marks a ride out and back.
export interface LoopSuggestion { leg: LegGeometry; sections: LegGeometry[]; heading: string; place?: string; cells: string[]; back: boolean }
// The routing service's loops and the town lookups, replaceable for tests; loops suggested before from the same start,
// each weighted by how recent it is; and the dice.
export interface LoopSearch {
  loops?: typeof traceLoops; town?: typeof townAt; earlier?: { cells: string[]; weight: number }[]; random?: () => number;
}

// The routing service finds the loops (engine/planner): twelve directions, each turned by the first throw of the dice
// and shaped by one of the next twelve, three tries each, rides out and back where loops fall short, and the three
// that fit best and differ, avoiding roads suggested lately. Here they are named: a loop after the town it passes
// most, a ride out and back after the town it turns in, other than the start's own and those naming an earlier
// suggestion; without one, its compass direction (`heading`) says where it goes.
export async function suggestLoops(start: Coord, target: LoopTarget, signal: AbortSignal,
  { loops = traceLoops, town = townAt, earlier = [], random = Math.random }: LoopSearch = {}): Promise<LoopSuggestion[]> {
  const found = await loops(start, target, Array.from({ length: 13 }, () => random()), earlier, signal);
  const lookup = (coord: Coord) => town(coord, signal).catch(() => undefined);
  const [home, ...along] = await Promise.all([lookup(start), ...found.map(loop => Promise.all(loop.along.map(lookup)))]);
  const used = new Set([home]);
  return found.map(({ leg, sections, heading, cells, back }, i) => {
    const counts = new Map<string, number>();
    for (const town of along[i]) if (town && !used.has(town)) counts.set(town, (counts.get(town) ?? 0) + 1);
    const place = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    used.add(place);
    return { leg, sections, heading, place, cells, back };
  });
}

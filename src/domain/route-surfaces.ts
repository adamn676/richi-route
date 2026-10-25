import { distanceMeters, isPlaced, legId, type RouteLeg, type RoutePoint, type Surface, type SurfaceSpan } from './route-model.ts';

const labels: Record<string, string> = {
  asphalt: 'Asphalt', paved: 'Befestigt', concrete: 'Beton',
  'concrete:lanes': 'Betonspuren', 'concrete:plates': 'Betonplatten',
  paving_stones: 'Pflaster, eben', sett: 'Natursteinpflaster, holprig', cobblestone: 'Kopfsteinpflaster, sehr holprig',
  wood: 'Holz', metal: 'Metall', gravel: 'Schotter', fine_gravel: 'Feiner Schotter',
  compacted: 'Verdichtetes Material', unpaved: 'Unbefestigt', ground: 'Naturboden',
  dirt: 'Erde', earth: 'Erde', grass: 'Gras', sand: 'Sand', mud: 'Schlamm',
  clay: 'Lehm', rock: 'Fels', pebblestone: 'Kies', grass_paver: 'Rasengitter', woodchips: 'Holzhackschnitzel',
  rough: 'Pflaster / Holz', likelyAsphalt: 'Vermutlich Asphalt', unknown: 'Unbekannt',
};

export interface SurfaceSection {
  id: string;
  legId: string;
  fromIndex: number;
  toIndex: number;
  fromMeters: number;
  toMeters: number;
  key: string;
  label: string;
  surface: Surface;
}

// Totals grouped like the map's colours, longest material first within each group.
const surfaceRank: Record<Surface, number> = { asphalt: 0, likelyAsphalt: 1, paved: 2, rough: 3, unpaved: 4, unknown: 5 };
export const bySurfaceThenLength = (a: { surface: Surface; meters: number }, b: { surface: Surface; meters: number }) =>
  surfaceRank[a.surface] - surfaceRank[b.surface] || b.meters - a.meters;

export function surfaceLabel(key: string) { return labels[key] ?? `Belag: ${key}`; }

export function inspectSurfaces(points: RoutePoint[], legs: Record<string, RouteLeg>) {
  const placed = points.filter(isPlaced);
  if (placed.length < 2) return null;
  const sections: SurfaceSection[] = [];
  let offset = 0;

  for (let index = 1; index < placed.length; index++) {
    const leg = legs[legId(placed[index - 1].id, placed[index].id)];
    if (!leg || leg.status !== 'routed') return null;
    const distances = [0];
    for (let vertex = 1; vertex < leg.coordinates.length; vertex++) {
      distances.push(distances[vertex - 1] + distanceMeters(leg.coordinates[vertex - 1], leg.coordinates[vertex]));
    }
    function add(fromIndex: number, toIndex: number, span?: SurfaceSpan) {
      if (toIndex <= fromIndex || distances[toIndex] === distances[fromIndex]) return;
      const surface = span?.surface ?? 'unknown';
      const tag = span?.surfaceTag;
      const key = tag && ['unknown', 'missing', 'other'].includes(tag) ? 'unknown' : tag ?? surface;
      sections.push({
        id: `${leg.id}:${fromIndex}:${toIndex}`, legId: leg.id, fromIndex, toIndex,
        fromMeters: offset + distances[fromIndex], toMeters: offset + distances[toIndex],
        key, label: surfaceLabel(key), surface,
      });
    }
    let cursor = 0;
    for (const span of leg.surfaces) {
      add(cursor, span.fromIndex);
      add(span.fromIndex, span.toIndex, span);
      cursor = span.toIndex;
    }
    add(cursor, leg.coordinates.length - 1);
    offset += distances.at(-1)!;
  }

  const totals = new Map<string, { key: string; label: string; surface: Surface; meters: number; count: number }>();
  for (const section of sections) {
    const total = totals.get(section.key) ?? { key: section.key, label: section.label, surface: section.surface, meters: 0, count: 0 };
    total.meters += section.toMeters - section.fromMeters;
    total.count++;
    totals.set(section.key, total);
  }
  return { sections, distanceMeters: offset, totals: [...totals.values()].sort(bySurfaceThenLength) };
}

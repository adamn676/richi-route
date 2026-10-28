import { distanceMeters, isPlaced, legId, type RouteLeg, type RoutePoint, type Surface, type SurfaceSpan } from './route-model.ts';

export const surfaceLabels: Record<Surface, string> = {
  paved: 'Befestigt', likelyPaved: 'Vermutlich befestigt', rough: 'Kopfsteinpflaster/Holzbrücke', unpaved: 'Unbefestigt', unknown: 'Unbekannt',
};

export interface SurfaceSection {
  id: string;
  legId: string;
  fromIndex: number;
  toIndex: number;
  fromMeters: number;
  toMeters: number;
  surface: Surface;
}

// From paved to unknown, the order of the labels above.
export const surfaces = Object.keys(surfaceLabels) as Surface[];
export const bySurface = (a: { surface: Surface }, b: { surface: Surface }) => surfaces.indexOf(a.surface) - surfaces.indexOf(b.surface);

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
    // Neighbouring stretches of the same kind are one section, whatever their materials.
    function add(fromIndex: number, toIndex: number, span?: SurfaceSpan) {
      if (toIndex <= fromIndex || distances[toIndex] === distances[fromIndex]) return;
      const surface = span?.surface ?? 'unknown', previous = sections.at(-1);
      // (zero-length pieces in between are skipped above)
      if (previous?.legId === leg.id && previous.toMeters === offset + distances[fromIndex] && previous.surface === surface) {
        Object.assign(previous, { id: `${leg.id}:${previous.fromIndex}:${toIndex}`, toIndex, toMeters: offset + distances[toIndex] });
        return;
      }
      sections.push({
        id: `${leg.id}:${fromIndex}:${toIndex}`, legId: leg.id, fromIndex, toIndex,
        fromMeters: offset + distances[fromIndex], toMeters: offset + distances[toIndex], surface,
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

  const totals = new Map<Surface, { surface: Surface; meters: number }>();
  for (const section of sections) {
    const total = totals.get(section.surface) ?? { surface: section.surface, meters: 0 };
    total.meters += section.toMeters - section.fromMeters;
    totals.set(section.surface, total);
  }
  return { sections, distanceMeters: offset, totals: [...totals.values()].sort(bySurface) };
}

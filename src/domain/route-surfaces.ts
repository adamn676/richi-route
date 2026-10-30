import { distanceMeters, isPlaced, legId, type RouteLeg, type RoutePoint, type Surface, type SurfaceSpan } from './route-model.ts';

export const surfaceLabels: Record<Surface, string> = {
  paved: 'Befestigt', likelyPaved: 'Vermutlich befestigt', rough: 'Kopfsteinpflaster/Holzbrücke', unpaved: 'Unbefestigt', unknown: 'Unbekannt',
};

export interface SurfacePart { legId: string; fromIndex: number; toIndex: number }

export interface SurfaceSection {
  id: string;
  // A section runs on across the stops and shaping points between legs, one part on each leg.
  parts: SurfacePart[];
  fromMeters: number;
  toMeters: number;
  surface: Surface;
  corrected: boolean;
}

// From paved to unknown, the order of the labels above.
export const surfaces = Object.keys(surfaceLabels) as Surface[];
export const bySurface = (a: { surface: Surface }, b: { surface: Surface }) => surfaces.indexOf(a.surface) - surfaces.indexOf(b.surface);

// Neighbouring stretches of the same kind are one section, whatever their materials and legs, apart from corrected ones.
function join(sections: SurfaceSection[], piece: SurfaceSection) {
  const previous = sections.at(-1);
  if (!previous || previous.toMeters !== piece.fromMeters || previous.surface !== piece.surface || previous.corrected !== piece.corrected) {
    sections.push(piece);
    return;
  }
  for (const part of piece.parts) {
    const last = previous.parts.at(-1)!;
    if (last.legId === part.legId && last.toIndex === part.fromIndex) last.toIndex = part.toIndex;
    else previous.parts.push(part);
  }
  previous.toMeters = piece.toMeters;
}

// A piece of a few metres (GPS jitter where a track stops, a kerb) is no section of its own: between two of one
// surface it joins them, otherwise its longer neighbour. What the rider corrected stays as it is.
const sliverMeters = 10;
function settle(pieces: SurfaceSection[]): SurfaceSection[] {
  const sections: SurfaceSection[] = [];
  const length = (section: SurfaceSection) => section.toMeters - section.fromMeters;
  pieces.forEach((piece, i) => {
    const before = sections.at(-1), after = pieces[i + 1];
    if (length(piece) < sliverMeters && !piece.corrected) {
      const neighbours = [before, after].filter((section): section is SurfaceSection => !!section && !section.corrected);
      const into = neighbours.length === 2 && neighbours[0].surface === neighbours[1].surface ? neighbours[0]
        : neighbours.sort((a, b) => length(b) - length(a))[0];
      if (into) piece.surface = into.surface;
    }
    join(sections, piece);
  });
  return sections;
}

export function inspectSurfaces(points: RoutePoint[], legs: Record<string, RouteLeg>) {
  const placed = points.filter(isPlaced);
  if (placed.length < 2) return null;
  const pieces: SurfaceSection[] = [];
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
      pieces.push({
        id: `${leg.id}:${fromIndex}`, parts: [{ legId: leg.id, fromIndex, toIndex }],
        fromMeters: offset + distances[fromIndex], toMeters: offset + distances[toIndex], surface: span?.surface ?? 'unknown', corrected: !!span?.osm,
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

  const sections = settle(pieces);
  const totals = new Map<Surface, { surface: Surface; meters: number }>();
  for (const section of sections) {
    const total = totals.get(section.surface) ?? { surface: section.surface, meters: 0 };
    total.meters += section.toMeters - section.fromMeters;
    totals.set(section.surface, total);
  }
  return { sections, distanceMeters: offset, totals: [...totals.values()].sort(bySurface) };
}

// The surfaces along part of a leg, and whether the rider corrected some of it.
export function inspectStretch(leg: RouteLeg, fromIndex: number, toIndex: number) {
  const spans = leg.surfaces.filter(span => span.toIndex > fromIndex && span.fromIndex < toIndex);
  const surfaces = new Set(spans.map(span => span.surface));
  const covered = spans.reduce((sum, span) => sum + Math.min(span.toIndex, toIndex) - Math.max(span.fromIndex, fromIndex), 0);
  if (covered < toIndex - fromIndex) surfaces.add('unknown');
  return { surfaces: [...surfaces], corrected: spans.some(span => span.osm) };
}

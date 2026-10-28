import { sameKind, spanKind, type Coord, type RouteLeg, type SpanKind, type SurfaceSpan } from './route-model.ts';

export type CorrectedSurface = 'paved' | 'rough' | 'unpaved';

export interface SurfaceCorrection {
  surface: CorrectedSurface;
  reportedOn: string;
  // The OSM surfaces it was reported over ('' for none): where OSM has another one by now, the correction lapses.
  osmSurfaces: string[];
  points: Coord[];
}

export interface SurfaceCorrections {
  schemaVersion: 1;
  corrections: SurfaceCorrection[];
}

export interface SurfaceReport {
  points: Coord[];
  // null removes the corrections of the stretch.
  surface: CorrectedSurface | null;
  osmSurfaces: string[];
}

const surfaceTags: Record<CorrectedSurface, string> = { paved: 'paved', rough: 'cobblestone', unpaved: 'unpaved' };

// What a mapper would tag after riding the stretch, as the routing engine's edits (key, the values it replaces or *,
// the new value or - to remove the tag): the profile's paved and unpaved tests also read tracktype and smoothness.
const edits: Record<CorrectedSurface, string[]> = {
  paved: [`surface * ${surfaceTags.paved}`, 'tracktype grade2|grade3|grade4|grade5 grade1'],
  rough: [`surface * ${surfaceTags.rough}`, 'tracktype grade2|grade3|grade4|grade5 grade1', 'smoothness * -'],
  unpaved: [`surface * ${surfaceTags.unpaved}`, 'tracktype grade1 grade2', 'smoothness * -'],
};

const fail = (message: string): never => { throw new Error(`Surface corrections: ${message}`); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const micro = (n: number) => Math.round(n * 1e6);
const isCoord = (value: unknown): value is Coord => Array.isArray(value) && value.length === 2
  && value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n * 1e6 - micro(n)) < 1e-5)
  && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
const isCorrected = (value: unknown): value is CorrectedSurface => typeof value === 'string' && Object.hasOwn(edits, value);
const pieceKey = (a: Coord, b: Coord) => [a, b].map(([lon, lat]) => `${micro(lon)},${micro(lat)}`).sort().join(' ');
const pieceKeys = (points: Coord[]) => new Set(points.slice(1).map((point, i) => pieceKey(points[i], point)));

function validStretch(points: unknown, osmSurfaces: unknown): void {
  if (!Array.isArray(points) || points.length < 2 || points.length > 100_000 || !points.every(isCoord)
    || points.some((point, i) => i && micro(points[i - 1][0]) === micro(point[0]) && micro(points[i - 1][1]) === micro(point[1]))) {
    fail('invalid points');
  }
  if (!Array.isArray(osmSurfaces) || !osmSurfaces.length || osmSurfaces.some(s => typeof s !== 'string' || !/^[a-z0-9_:.-]*$/.test(s))) {
    fail('invalid OSM surfaces');
  }
}

export function validateCorrections(data: unknown): SurfaceCorrections {
  if (!object(data) || data.schemaVersion !== 1 || !Array.isArray(data.corrections) || Object.keys(data).length !== 2) fail('unsupported document');
  for (const correction of (data as { corrections: unknown[] }).corrections) {
    if (!object(correction) || Object.keys(correction).sort().join() !== 'osmSurfaces,points,reportedOn,surface') fail('unexpected fields');
    const { surface, reportedOn, osmSurfaces, points } = correction as Record<string, unknown>;
    if (!isCorrected(surface)) fail('unknown surface');
    if (typeof reportedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(reportedOn)) fail('a report date is required');
    validStretch(points, osmSurfaces);
  }
  return data as unknown as SurfaceCorrections;
}

// The corrections with the reported stretch: the corrections it overlaps keep their other parts.
export function recordReport(data: SurfaceCorrections, report: unknown, reportedOn: string): SurfaceCorrections {
  if (!object(report) || Object.keys(report).sort().join() !== 'osmSurfaces,points,surface' || (report.surface !== null && !isCorrected(report.surface))) {
    fail('invalid report');
  }
  const { points, surface, osmSurfaces } = report as unknown as SurfaceReport;
  validStretch(points, osmSurfaces);
  const reported = pieceKeys(points);
  const corrections = data.corrections.flatMap(correction => {
    const parts: Coord[][] = [[correction.points[0]]];
    correction.points.slice(1).forEach((point, i) => {
      if (reported.has(pieceKey(correction.points[i], point))) parts.push([point]);
      else parts.at(-1)!.push(point);
    });
    return parts.filter(part => part.length > 1).map(part => ({ ...correction, points: part }));
  });
  if (surface) corrections.push({ surface, reportedOn, osmSurfaces: [...new Set(osmSurfaces)].sort(), points });
  return validateCorrections({ schemaVersion: 1, corrections });
}

// One line per correction, for readable git diffs.
export function formatCorrections(data: SurfaceCorrections): string {
  const lines = data.corrections.map(({ surface, reportedOn, osmSurfaces, points }) =>
    '\n    ' + JSON.stringify({ surface, reportedOn, osmSurfaces, points }));
  return `{\n  "schemaVersion": 1,\n  "corrections": [${lines.join(',')}${lines.length ? '\n  ' : ''}]\n}\n`;
}

// The routing engine's file (see engine/router/src/surfaces.rs).
export function compileCorrections(data: SurfaceCorrections): string {
  return ['richiroute-surfaces\t1', ...validateCorrections(data).corrections.map(c => [
    c.osmSurfaces.join(','), edits[c.surface].join(';'),
    c.points.map(([lon, lat]) => `${micro(lon) + 180_000_000},${micro(lat) + 90_000_000}`).join(' '),
  ].join('\t'))].join('\n') + '\n';
}

// What OSM says along the stretch from fromIndex to toIndex of the leg ('' for no surface tag).
export function osmSurfaces(leg: RouteLeg, fromIndex: number, toIndex: number): string[] {
  const found = new Set<string>();
  let covered = fromIndex;
  for (const span of leg.surfaces) {
    if (span.toIndex <= fromIndex || span.fromIndex >= toIndex) continue;
    if (span.fromIndex > covered) found.add('');
    found.add((span.osm ?? span).surfaceTag ?? '');
    covered = span.toIndex;
  }
  if (covered < toIndex) found.add('');
  return [...found].sort();
}

// The legs as the routing engine describes them once the report is saved: the stretch with the reported surface, or
// with OSM's again. A piece OSM already tags so stays as it is, as in the engine. `memo` keeps one relabelled leg per
// leg across several sets of legs (the undo history).
export function applyReport(legs: Record<string, RouteLeg>, { points, surface }: Pick<SurfaceReport, 'points' | 'surface'>,
  memo = new Map<RouteLeg, RouteLeg>()): Record<string, RouteLeg> {
  const reported = pieceKeys(points);
  // pieces outside the stretch's box are ruled out without building their keys
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of points) [west, south, east, north] = [Math.min(west, lon), Math.min(south, lat), Math.max(east, lon), Math.max(north, lat)];
  const inside = ([lon, lat]: Coord) => lon >= west && lon <= east && lat >= south && lat <= north;
  function relabel(leg: RouteLeg): RouteLeg {
    let kinds: (SpanKind | undefined)[] | undefined, changed = false;
    for (let k = 0; k < leg.coordinates.length - 1; k++) {
      if (!inside(leg.coordinates[k]) || !reported.has(pieceKey(leg.coordinates[k], leg.coordinates[k + 1]))) continue;
      if (!kinds) {
        kinds = [];
        for (const span of leg.surfaces) for (let i = span.fromIndex; i < span.toIndex; i++) kinds[i] = spanKind(span);
      }
      const { osm, ...current } = kinds[k] ?? { surface: 'unknown' };
      if (surface && !osm && current.surfaceTag === surfaceTags[surface]) continue;
      kinds[k] = surface ? { surface, surfaceTag: surfaceTags[surface], osm: osm ?? current } : osm ?? current;
      changed = true;
    }
    if (!kinds || !changed) return leg;
    const surfaces: SurfaceSpan[] = [];
    kinds.forEach((kind, k) => {
      if (!kind) return;
      const previous = surfaces.at(-1);
      if (previous?.toIndex === k && sameKind(previous, kind)) previous.toIndex = k + 1;
      else surfaces.push({ fromIndex: k, toIndex: k + 1, ...kind });
    });
    return { ...leg, surfaces };
  }
  return Object.fromEntries(Object.entries(legs).map(([id, leg]) => {
    if (!memo.has(leg)) memo.set(leg, relabel(leg));
    return [id, memo.get(leg)!];
  }));
}

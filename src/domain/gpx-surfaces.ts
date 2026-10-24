import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { distanceMeters, type Coord, type LegGeometry, type Surface, type SurfaceSpan } from './route-model.ts';
import type { GpxTrack } from './gpx-track.ts';
import { bySurfaceThenLength, surfaceLabel } from './route-surfaces.ts';
import { routeStyle } from '../config/mapStyle.ts';

export interface GpxPortion { segment: number; from: number; to: number; points: Coord[] }
export const surfaceLegend = [
  { color: routeStyle.asphalt, label: 'Asphalt' }, { color: routeStyle.paved, label: 'Befestigt' },
  { color: routeStyle.rough, label: 'Pflaster / Holz' }, { color: routeStyle.unpaved, label: 'Unbefestigt' },
  { color: routeStyle.unknown, label: 'Sonstige / unbekannt' },
];

export function gpxSurfacePortions(track: GpxTrack): GpxPortion[] {
  const portions: GpxPortion[] = [];
  track.segments.forEach((segment, s) => {
    const distances = track.distances[s];
    let from = 0, lastAnchor = 0, points = [segment.coordinates[0]];
    function finish(to: number) {
      if (to > from && distances[to] > distances[from]) {
        if (lastAnchor !== to) points.push(segment.coordinates[to]);
        portions.push({ segment: s, from, to, points });
      }
      from = lastAnchor = to;
      points = [segment.coordinates[to]];
    }
    for (let i = 1; i < segment.coordinates.length; i++) {
      // Long straight chords do not provide enough evidence about the road taken.
      if (distances[i] - distances[i - 1] > 200) { finish(i - 1); from = lastAnchor = i; points = [segment.coordinates[i]]; continue; }
      if (distances[i] - distances[lastAnchor] >= 10) { points.push(segment.coordinates[i]); lastAnchor = i; }
      if (points.length >= 64 || distances[i] - distances[from] >= 2000) finish(i);
    }
    finish(segment.coordinates.length - 1);
  });
  return portions;
}

function longitudeDelta(from: number, to: number) { return ((to - from + 540) % 360) - 180; }
function positionAt(coordinates: Coord[], distances: number[], distance: number, cursor: { index: number }): Coord {
  while (cursor.index + 1 < distances.length - 1 && distances[cursor.index + 1] <= distance) cursor.index++;
  const i = cursor.index, next = Math.min(i + 1, coordinates.length - 1);
  const ratio = distances[next] > distances[i] ? (distance - distances[i]) / (distances[next] - distances[i]) : 0;
  return [coordinates[i][0] + longitudeDelta(coordinates[i][0], coordinates[next][0]) * ratio,
    coordinates[i][1] + (coordinates[next][1] - coordinates[i][1]) * ratio];
}

export function matchGpxSurfaces(track: GpxTrack, portion: GpxPortion, candidate: LegGeometry): SurfaceSpan[] {
  const original = track.segments[portion.segment].coordinates.slice(portion.from, portion.to + 1);
  const offset = track.distances[portion.segment][portion.from];
  const distances = track.distances[portion.segment].slice(portion.from, portion.to + 1).map(d => d - offset);
  const length = distances.at(-1)!;
  const mapped = [0];
  for (let i = 1; i < candidate.coordinates.length; i++) mapped.push(mapped[i - 1] + distanceMeters(candidate.coordinates[i - 1], candidate.coordinates[i]));
  const mappedLength = mapped.at(-1)!;
  if (!length || !mappedLength || Math.abs(length - mappedLength) > Math.max(10, length * .03)) return [];

  // Compare both polylines in travel order at every vertex and at least every 10 m.
  // A nearby crossing or an out-and-back cannot borrow tags from a different visit.
  const originalCursor = { index: 0 }, mappedCursor = { index: 0 };
  let a = 0, b = 0, step = 0;
  const steps = Math.ceil(Math.max(length, mappedLength) / 10);
  while (a < distances.length || b < mapped.length || step <= steps) {
    const fraction = Math.min(a < distances.length ? distances[a] / length : Infinity,
      b < mapped.length ? mapped[b] / mappedLength : Infinity, step <= steps ? step / steps : Infinity);
    if (distanceMeters(positionAt(original, distances, fraction * length, originalCursor),
      positionAt(candidate.coordinates, mapped, fraction * mappedLength, mappedCursor)) > 8) return [];
    while (a < distances.length && distances[a] / length <= fraction) a++;
    while (b < mapped.length && mapped[b] / mappedLength <= fraction) b++;
    if (step / steps <= fraction) step++;
  }

  const spans: SurfaceSpan[] = [];
  let surfaceIndex = 0;
  for (let i = 1; i < distances.length; i++) {
    const start = distances[i - 1] / length * mappedLength, end = distances[i] / length * mappedLength;
    if (end <= start) continue;
    while (surfaceIndex < candidate.surfaces.length && mapped[candidate.surfaces[surfaceIndex].toIndex] <= start + .001) surfaceIndex++;
    const span = candidate.surfaces[surfaceIndex];
    if (!span?.surfaceTag || ['unknown', 'missing', 'other'].includes(span.surfaceTag) ||
      mapped[span.fromIndex] > start + .001 || mapped[span.toIndex] < end - .001) continue;
    const fromIndex = portion.from + i - 1, toIndex = portion.from + i;
    const previous = spans.at(-1);
    if (previous?.toIndex === fromIndex && previous.surfaceTag === span.surfaceTag) previous.toIndex = toIndex;
    else spans.push({ fromIndex, toIndex, surface: span.surface, surfaceTag: span.surfaceTag });
  }
  return spans;
}

export function inspectGpxSurfaces(track: GpxTrack, matched: SurfaceSpan[][]) {
  const features: Feature<LineString | Point>[] = [];
  const totals = new Map<string, { key: string; label: string; surface: Surface; color: string; meters: number }>();
  let estimatedMeters = 0;
  track.geojson.features.forEach((feature, s) => {
    if (feature.geometry.type === 'Point') {
      features.push({ ...feature, properties: { color: routeStyle.unknown } });
      return;
    }
    const coordinates = feature.geometry.coordinates;
    function add(from: number, to: number, span?: SurfaceSpan) {
      if (to <= from) return;
      const key = span?.surfaceTag ?? 'unknown', surface = span?.surface ?? 'unknown', color = routeStyle[surface];
      const meters = track.distances[s][to] - track.distances[s][from];
      const total = totals.get(key) ?? { key, label: surfaceLabel(key), surface, color, meters: 0 };
      total.meters += meters; totals.set(key, total);
      if (key !== 'unknown') estimatedMeters += meters;
      const previous = features.at(-1);
      if (previous?.geometry.type === 'LineString' && previous.properties?.segment === s && previous.properties.color === color) {
        for (let i = from + 1; i <= to; i++) previous.geometry.coordinates.push(coordinates[i]);
      } else features.push({ type: 'Feature', properties: { color, segment: s }, geometry: { type: 'LineString', coordinates: coordinates.slice(from, to + 1) } });
    }
    let cursor = 0;
    for (const span of matched[s] ?? []) { add(cursor, span.fromIndex); add(span.fromIndex, span.toIndex, span); cursor = span.toIndex; }
    add(cursor, coordinates.length - 1);
  });
  return { geojson: { type: 'FeatureCollection', features } as FeatureCollection<LineString | Point>, estimatedMeters,
    totals: [...totals.values()].sort(bySurfaceThenLength) };
}

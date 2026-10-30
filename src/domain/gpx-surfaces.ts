import { sameKind, spanKind, type Coord, type LegGeometry, type Surface, type SurfaceSpan } from './route-model.ts';
import type { GpxTrack } from './gpx-track.ts';

export interface GpxPortion { segment: number; from: number; to: number; points: Coord[] }

// Portions of about 2 km are traced through a point every 100 m. Denser points snap onto sidewalks and side
// streets and send the trace on detours; a portion that does not match is split and traced again.
const portionMeters = 2000, anchorMeters = 100, minPortionMeters = 150;

function gpxPortion(track: GpxTrack, segment: number, from: number, to: number): GpxPortion {
  const coordinates = track.segments[segment].coordinates, distances = track.distances[segment];
  const points = [coordinates[from]];
  let anchor = from;
  for (let i = from + 1; i < to; i++) if (distances[i] - distances[anchor] >= anchorMeters) { points.push(coordinates[i]); anchor = i; }
  points.push(coordinates[to]);
  return { segment, from, to, points };
}

export function gpxSurfacePortions(track: GpxTrack): GpxPortion[] {
  const portions: GpxPortion[] = [];
  track.segments.forEach((segment, s) => {
    const distances = track.distances[s];
    let from = 0;
    const finish = (to: number) => { if (to > from && distances[to] > distances[from]) portions.push(gpxPortion(track, s, from, to)); };
    for (let i = 1; i < segment.coordinates.length; i++) {
      // Long straight chords do not provide enough evidence about the road taken.
      if (distances[i] - distances[i - 1] > 200) { finish(i - 1); from = i; }
      else if (distances[i] - distances[from] >= portionMeters) { finish(i); from = i; }
    }
    finish(segment.coordinates.length - 1);
  });
  return portions;
}

// The two halves of a portion that did not match, or none once it is short.
export function splitGpxPortion(track: GpxTrack, portion: GpxPortion): GpxPortion[] {
  const distances = track.distances[portion.segment], { segment, from, to } = portion;
  if (to - from < 2 || distances[to] - distances[from] <= minPortionMeters) return [];
  let middle = from + 1;
  while (middle < to - 1 && distances[middle] - distances[from] < (distances[to] - distances[from]) / 2) middle++;
  return [gpxPortion(track, segment, from, middle), gpxPortion(track, segment, middle, to)];
}

const largest = <T>(weights: Map<T, number>) => [...weights].reduce((most, next) => next[1] > most[1] ? next : most)[0];

function longitudeDelta(from: number, to: number) { return ((to - from + 540) % 360) - 180; }

// Points every 5 m in local metres, each with its position along the line (vertex index plus fraction).
function samples(coordinates: Coord[], [lon0, lat0]: Coord) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const xy = coordinates.map(([lon, lat]) => [longitudeDelta(lon0, lon) * kx, (lat - lat0) * ky]);
  const points = [{ x: xy[0][0], y: xy[0][1], at: 0 }], vertices = [0];
  for (let k = 1; k < xy.length; k++) {
    const [ax, ay] = xy[k - 1], [bx, by] = xy[k], steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 5));
    for (let t = 1; t <= steps; t++) points.push({ x: ax + (bx - ax) * t / steps, y: ay + (by - ay) * t / steps, at: k - 1 + t / steps });
    vertices.push(points.length - 1);
  }
  return { points, vertices };
}

// Matches a traced portion to the track, or returns null when they are not the same way: both are walked in
// travel order and must stay within 8 m (a discrete Fréchet distance), so a parallel road, a detour, a reversed
// path or a missing return leg cannot lend its tags. Small length differences and GPS jitter do not matter.
export function matchGpxSurfaces(track: GpxTrack, portion: GpxPortion, candidate: LegGeometry): SurfaceSpan[] | null {
  const original = track.segments[portion.segment].coordinates.slice(portion.from, portion.to + 1);
  const A = samples(original, original[0]), B = samples(candidate.coordinates, original[0]);
  const n = A.points.length, m = B.points.length;
  if (n * m > 4e6) return null;
  const near = (i: number, j: number) => Math.hypot(A.points[i].x - B.points[j].x, A.points[i].y - B.points[j].y) <= 8;
  const reach = new Uint8Array(n * m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    // Reachability first: most cells far from the diagonal never need a distance.
    if (((!i && !j) || (i && reach[(i - 1) * m + j]) || (j && reach[i * m + j - 1]) || (i && j && reach[(i - 1) * m + j - 1])) && near(i, j)) reach[i * m + j] = 1;
  }
  if (!reach[n * m - 1]) return null;
  // Walking back gives, for each track point, the first and last traced points it pairs with.
  const first = new Int32Array(n).fill(m), last = new Int32Array(n).fill(-1);
  for (let i = n - 1, j = m - 1; ;) {
    first[i] = Math.min(first[i], j); last[i] = Math.max(last[i], j);
    if (!i && !j) break;
    if (i && j && reach[(i - 1) * m + j - 1]) { i--; j--; } else if (i && reach[(i - 1) * m + j]) i--; else j--;
  }

  const spanOf: (SurfaceSpan | undefined)[] = [];
  for (const span of candidate.surfaces) for (let k = span.fromIndex; k < span.toIndex; k++) spanOf[k] = span;
  const spans: SurfaceSpan[] = [];
  for (let v = 1; v < original.length; v++) {
    // The traced stretch paired with this track step, in metres per span. The step takes the surface covering most of
    // it, with the tag of that surface's largest part: a junction, the next way of the same road or a few metres
    // tagged otherwise within a long step leave no gap.
    const a = last[A.vertices[v - 1]], b = first[A.vertices[v]];
    const shares = new Map<SurfaceSpan | undefined, number>();
    const share = (j: number, k: number) => {
      const span = spanOf[Math.min(Math.floor((B.points[j].at + B.points[k].at) / 2), candidate.coordinates.length - 2)];
      shares.set(span, (shares.get(span) ?? 0) + Math.hypot(B.points[k].x - B.points[j].x, B.points[k].y - B.points[j].y));
    };
    if (a === b) share(a, a);
    for (let j = Math.min(a, b); j < Math.max(a, b); j++) share(j, j + 1);
    const surfaces = new Map<Surface, number>();
    for (const [span, metres] of shares) surfaces.set(span?.surface ?? 'unknown', (surfaces.get(span?.surface ?? 'unknown') ?? 0) + metres);
    const surface = largest(surfaces);
    if (surface === 'unknown') continue;
    const span = largest(new Map([...shares].filter(([span]) => span?.surface === surface)))!;
    const fromIndex = portion.from + v - 1, toIndex = portion.from + v;
    const previous = spans.at(-1);
    if (previous?.toIndex === fromIndex && sameKind(previous, span)) previous.toIndex = toIndex;
    else spans.push({ fromIndex, toIndex, ...spanKind(span) });
  }
  return spans;
}

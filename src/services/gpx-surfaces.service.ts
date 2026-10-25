import type { GpxTrack } from '../domain/gpx-track.ts';
import { routingConcurrency, type Coord, type LegGeometry, type SurfaceSpan } from '../domain/route-model.ts';
import { gpxSurfacePortions, matchGpxSurfaces, splitGpxPortion, type GpxPortion } from '../domain/gpx-surfaces.ts';
import { traceGpxPortion } from './route.service.ts';

// Portions are traced a few at a time; routing requests from editing still go first, and two slots stay free for them.
const parallelTraces = routingConcurrency - 2;

// Progress counts metres of track checked, as portions that do not match are split and traced again.
export async function lookupGpxSurfaces(track: GpxTrack, signal: AbortSignal,
  progress: (completed: number, total: number) => void,
  trace: (points: Coord[], signal: AbortSignal) => Promise<LegGeometry> = traceGpxPortion) {
  const queue = gpxSurfacePortions(track);
  const surfaces: SurfaceSpan[][] = track.segments.map(() => []);
  const length = (portion: GpxPortion) => track.distances[portion.segment][portion.to] - track.distances[portion.segment][portion.from];
  const total = queue.reduce((sum, portion) => sum + length(portion), 0);
  let completed = 0, error = '';
  progress(0, total);
  async function work() {
    for (let portion = queue.shift(); portion && !error; portion = queue.shift()) {
      signal.throwIfAborted();
      try {
        const candidate = await trace(portion.points, signal);
        signal.throwIfAborted();
        const spans = matchGpxSurfaces(track, portion, candidate);
        const halves = spans ? [] : splitGpxPortion(track, portion);
        if (halves.length) queue.unshift(...halves);
        else {
          surfaces[portion.segment].push(...spans ?? []);
          completed += length(portion);
          progress(completed, total);
        }
      } catch (cause) {
        signal.throwIfAborted();
        // A failed service ends the lookup; portions already checked keep their surfaces.
        error ||= cause instanceof Error ? cause.message : 'Beläge konnten nicht ermittelt werden.';
      }
    }
  }
  await Promise.all(Array.from({ length: parallelTraces }, work));
  signal.throwIfAborted();
  for (const spans of surfaces) spans.sort((a, b) => a.fromIndex - b.fromIndex);
  return { surfaces, error };
}

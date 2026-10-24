import type { GpxTrack } from '../domain/gpx-track.ts';
import type { Coord, LegGeometry, SurfaceSpan } from '../domain/route-model.ts';
import { gpxSurfacePortions, matchGpxSurfaces } from '../domain/gpx-surfaces.ts';
import { traceGpxPortion } from './route.service.ts';

export async function lookupGpxSurfaces(track: GpxTrack, signal: AbortSignal,
  progress: (completed: number, total: number) => void,
  trace: (points: Coord[], signal: AbortSignal) => Promise<LegGeometry> = traceGpxPortion) {
  const portions = gpxSurfacePortions(track);
  const surfaces: SurfaceSpan[][] = track.segments.map(() => []);
  progress(0, portions.length);
  for (let i = 0; i < portions.length; i++) {
    signal.throwIfAborted();
    const portion = portions[i];
    try {
      const candidate = await trace(portion.points, signal);
      signal.throwIfAborted();
      for (const span of matchGpxSurfaces(track, portion, candidate)) surfaces[portion.segment].push(span);
    } catch (cause) {
      signal.throwIfAborted();
      return { surfaces, error: cause instanceof Error ? cause.message : 'Beläge konnten nicht ermittelt werden.' };
    }
    progress(i + 1, portions.length);
    // Let input and cancellation run between portions, including cached responses.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  return { surfaces, error: '' };
}

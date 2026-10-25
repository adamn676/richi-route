import { cumulativeAscent, type LegGeometry, type SurfaceSpan } from './route-model.ts';
import type { GpxTrack } from './gpx-track.ts';
import { routingPolicyVersion } from '../config/routing-policy.ts';

// A GPX track opened as a route keeps its exact path and heights, cut into sections of about 5 km
// between shaping points, so an edit re-plans only the section it touches. Each section remembers
// where it lies in its track segment, for surfaces found later.
export const gpxSectionMeters = 5000;
export interface GpxSection extends LegGeometry { segment: number; from: number }

// Where a line of these cumulative distances is cut into sections; no cut leaves a last section shorter than half the length.
export function sectionCuts(distances: number[]): number[] {
  const last = distances.length - 1, cuts = [0];
  for (let i = 1; i < last; i++) {
    if (distances[i] - distances[cuts.at(-1)!] >= gpxSectionMeters && distances[last] - distances[i] >= gpxSectionMeters / 2) cuts.push(i);
  }
  if (last > 0) cuts.push(last);
  return cuts;
}

export function gpxSections(track: GpxTrack): GpxSection[][] {
  return track.segments.map((segment, s) => {
    const distances = track.distances[s];
    // Ascent is filtered along the whole segment, so the sections add up to the track's ascent.
    const climbed = cumulativeAscent(segment.elevations);
    const cuts = sectionCuts(distances);
    return cuts.slice(1).map((to, k): GpxSection => {
      const from = cuts[k];
      const heights = segment.elevations.slice(from, to + 1);
      const elevations = heights.every((height): height is number => height !== null) ? heights : null;
      return { segment: s, from, coordinates: segment.coordinates.slice(from, to + 1), elevations,
        ascentMeters: elevations && climbed[to] - climbed[from], distanceMeters: distances[to] - distances[from], surfaces: [],
        routingPolicy: routingPolicyVersion };
    });
  }).filter(sections => sections.length);
}

// Surface spans cut to the stretch between two vertices and counted from its start.
export function clipSpans(spans: SurfaceSpan[], from: number, to: number): SurfaceSpan[] {
  return spans.filter(span => span.toIndex > from && span.fromIndex < to).map(span => ({
    ...span, fromIndex: Math.max(span.fromIndex, from) - from, toIndex: Math.min(span.toIndex, to) - from,
  }));
}

// A track segment's surfaces, cut to one section.
export function sectionSurfaces(section: GpxSection, spans: SurfaceSpan[]): SurfaceSpan[] {
  return clipSpans(spans, section.from, section.from + section.coordinates.length - 1);
}

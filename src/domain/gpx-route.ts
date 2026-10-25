import { cumulativeAscent, type LegGeometry, type SurfaceSpan } from './route-model.ts';
import type { GpxTrack } from './gpx-track.ts';
import { routingPolicyVersion } from '../config/routing-policy.ts';

// A GPX track opened as a route keeps its exact path and heights, cut into sections of about 5 km
// between shaping points, so an edit re-plans only the section it touches. Each section remembers
// where it lies in its track segment, for surfaces found later.
export const gpxSectionMeters = 5000;
export interface GpxSection extends LegGeometry { segment: number; from: number }

export function gpxSections(track: GpxTrack): GpxSection[][] {
  return track.segments.map((segment, s) => {
    const distances = track.distances[s], last = segment.coordinates.length - 1;
    // Ascent is filtered along the whole segment, so the sections add up to the track's ascent.
    const climbed = cumulativeAscent(segment.elevations);
    const cuts = [0];
    // No cut leaves a last section shorter than half the length.
    for (let i = 1; i < last; i++) {
      if (distances[i] - distances[cuts.at(-1)!] >= gpxSectionMeters && distances[last] - distances[i] >= gpxSectionMeters / 2) cuts.push(i);
    }
    if (last > 0) cuts.push(last);
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

// A track segment's surfaces, cut to one section and counted from its start.
export function sectionSurfaces(section: GpxSection, spans: SurfaceSpan[]): SurfaceSpan[] {
  const to = section.from + section.coordinates.length - 1;
  return spans.filter(span => span.toIndex > section.from && span.fromIndex < to).map(span => ({
    ...span, fromIndex: Math.max(span.fromIndex, section.from) - section.from, toIndex: Math.min(span.toIndex, to) - section.from,
  }));
}

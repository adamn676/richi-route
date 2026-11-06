import type { Feature, LineString } from 'geojson';
import { drawnSpans, type Surface } from '../domain/route-model.ts';
import type { RouteFeature } from '@/stores/route.store';

export interface RouteSegmentProperties {
  legId: string;
  fromId: string;
  toId: string;
  status: 'routed' | 'air';
  waiting: boolean;
  // Just calculated, fading in.
  arriving?: boolean;
  surface: Surface;
}

export function getSegments(feature: RouteFeature): Feature<LineString, RouteSegmentProperties>[] {
  const segments: Feature<LineString, RouteSegmentProperties>[] = [];
  const coordinates = feature.geometry.coordinates;
  const { surfaces, ...properties } = feature.properties;
  if (coordinates.length < 2) throw new Error('Ein Streckenabschnitt hat keine gültige Geometrie.');

  function addSegment(from: number, to: number, surface: Surface): void {
    if (to <= from) return;
    segments.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coordinates.slice(from, to + 1) },
      properties: { ...properties, surface },
    });
  }

  if (feature.properties.status === 'air') {
    addSegment(0, coordinates.length - 1, 'unknown');
    return segments;
  }

  for (const span of drawnSpans(surfaces, coordinates.length - 1)) addSegment(span.fromIndex, span.toIndex, span.surface);
  return segments;
}

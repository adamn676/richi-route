import type { Feature, LineString } from 'geojson';
import type { Surface } from '@/domain/route-model';
import type { EditorRoute } from '@/stores/route.store';

export interface RouteSegmentProperties {
  legId: string;
  fromId: string;
  toId: string;
  status: 'routed' | 'air';
  surface: Surface;
}

export function getSegments(route: EditorRoute): Feature<LineString, RouteSegmentProperties>[] {
  const segments: Feature<LineString, RouteSegmentProperties>[] = [];
  for (const feature of route.features) {
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
      continue;
    }

    let nextIndex = 0;
    for (const span of surfaces) {
      if (span.fromIndex > nextIndex) addSegment(nextIndex, span.fromIndex, 'unknown');
      addSegment(span.fromIndex, span.toIndex, span.surface);
      nextIndex = span.toIndex;
    }
    addSegment(nextIndex, coordinates.length - 1, 'unknown');
  }
  return segments;
}

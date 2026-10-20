import type { Map, GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import {
  SEGMENTS_AIR_LAYER,
  SEGMENTS_BASE_LAYER,
  SEGMENTS_OUTLINE_LAYER,
  SEGMENTS_ROUTE_LAYER,
  SEGMENTS_SOURCE_ID,
} from '@/config/map.config';
import { routeStyle } from '@/config/mapStyle';
import type { EditorRoute } from '@/stores/route.store';
import { getSegments } from '@/utils/geometry';

export function useSegmentedRoute() {
  function renderSegments(map: Map, route: EditorRoute | null): void {
    const data: FeatureCollection = {
      type: 'FeatureCollection',
      features: route ? getSegments(route) : [],
    };

    if (!map.getSource(SEGMENTS_SOURCE_ID)) {
      map.addSource(SEGMENTS_SOURCE_ID, { type: 'geojson', data });
      map.addLayer({
        id: SEGMENTS_OUTLINE_LAYER,
        type: 'line',
        source: SEGMENTS_SOURCE_ID,
        filter: ['==', ['get', 'status'], 'routed'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': routeStyle.outlineColor,
          'line-width': 9,
          'line-opacity': .95,
        },
      });
      map.addLayer({
        id: SEGMENTS_ROUTE_LAYER,
        type: 'line',
        source: SEGMENTS_SOURCE_ID,
        filter: ['==', ['get', 'status'], 'routed'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'match',
            ['get', 'surface'],
            'asphalt', routeStyle.asphalt,
            'paved', routeStyle.paved,
            'rough', routeStyle.rough,
            'unpaved', routeStyle.unpaved,
            routeStyle.unknown,
          ],
          'line-width': 5,
        },
      });
      map.addLayer({
        id: SEGMENTS_AIR_LAYER,
        type: 'line',
        source: SEGMENTS_SOURCE_ID,
        filter: ['==', ['get', 'status'], 'air'],
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': routeStyle.air,
          'line-width': 4,
          'line-dasharray': [2, 2],
        },
      });
      map.addLayer({
        id: SEGMENTS_BASE_LAYER,
        type: 'line',
        source: SEGMENTS_SOURCE_ID,
        paint: { 'line-color': '#fff', 'line-width': 30, 'line-opacity': .01 },
      });
    } else {
      (map.getSource(SEGMENTS_SOURCE_ID) as GeoJSONSource).setData(data);
    }
  }

  return { renderSegments };
}

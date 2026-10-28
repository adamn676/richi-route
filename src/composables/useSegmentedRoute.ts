import type { Map as MaplibreMap, ExpressionSpecification, GeoJSONSource } from 'maplibre-gl';
import type { Feature, LineString } from 'geojson';
import {
  MAP_LABELS_ANCHOR,
  SEGMENTS_AIR_LAYER,
  SEGMENTS_BASE_LAYER,
  SEGMENTS_OUTLINE_LAYER,
  SEGMENTS_ROUTE_LAYER,
  SEGMENTS_SOURCE_ID,
} from '@/config/map.config';
import { routeStyle } from '@/config/mapStyle';
import type { EditorRoute, RouteFeature } from '@/stores/route.store';
import { getSegments } from '@/utils/geometry';

// While a surface section is shown (SurfaceFocusLayer), the rest of the route fades.
const faded: ExpressionSpecification = ['boolean', ['global-state', 'surfaceFocus'], false];

export function useSegmentedRoute() {
  // Segment ids per drawn leg feature, so that an edit only sends the changed legs to the map.
  let drawn = new Map<RouteFeature, number[]>();
  let nextId = 0;

  function renderSegments(map: MaplibreMap, route: EditorRoute | null): void {
    const next = new Map<RouteFeature, number[]>();
    const add: Feature<LineString>[] = [];
    for (const feature of route?.features ?? []) {
      let ids = drawn.get(feature);
      if (!ids) {
        ids = [];
        for (const segment of getSegments(feature)) {
          segment.id = nextId;
          ids.push(nextId++);
          add.push(segment);
        }
      }
      next.set(feature, ids);
    }

    const source = map.getSource<GeoJSONSource>(SEGMENTS_SOURCE_ID);
    if (!source) {
      map.addSource(SEGMENTS_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: add } });
      map.addLayer({
        id: SEGMENTS_OUTLINE_LAYER,
        type: 'line',
        source: SEGMENTS_SOURCE_ID,
        filter: ['==', ['get', 'status'], 'routed'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': routeStyle.outlineColor,
          'line-width': 9,
          'line-opacity': ['case', faded, .35, .95],
        },
      }, MAP_LABELS_ANCHOR);
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
            'paved', routeStyle.paved,
            'likelyPaved', routeStyle.likelyPaved,
            'rough', routeStyle.rough,
            'unpaved', routeStyle.unpaved,
            routeStyle.unknown,
          ],
          'line-width': 5,
          'line-opacity': ['case', faded, .35, 1],
        },
      }, MAP_LABELS_ANCHOR);
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
      }, MAP_LABELS_ANCHOR);
      map.addLayer({
        id: SEGMENTS_BASE_LAYER,
        type: 'line',
        source: SEGMENTS_SOURCE_ID,
        paint: { 'line-color': '#fff', 'line-width': 30, 'line-opacity': .01 },
      }, MAP_LABELS_ANCHOR);
    } else {
      const remove = [...drawn].flatMap(([feature, ids]) => next.has(feature) ? [] : ids);
      // Nothing recorded, e.g. after a remount: replace whatever the source holds.
      if (add.length || remove.length) source.updateData({ removeAll: !drawn.size, remove, add });
    }
    drawn = next;
  }

  return { renderSegments };
}

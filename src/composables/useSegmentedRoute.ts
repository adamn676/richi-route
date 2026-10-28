import type { Map as MaplibreMap, ExpressionSpecification, GeoJSONSource, LineLayerSpecification } from 'maplibre-gl';
import type { Feature, LineString } from 'geojson';
import {
  MAP_LABELS_ANCHOR,
  SEGMENTS_AIR_LAYER,
  SEGMENTS_ARRIVING_LAYER,
  SEGMENTS_ARRIVING_OUTLINE_LAYER,
  SEGMENTS_BASE_LAYER,
  SEGMENTS_FORMER_LAYER,
  SEGMENTS_FORMER_OUTLINE_LAYER,
  SEGMENTS_FORMER_SOURCE_ID,
  SEGMENTS_OUTLINE_LAYER,
  SEGMENTS_ROUTE_LAYER,
  SEGMENTS_SOURCE_ID,
  SEGMENTS_WAITING_LAYER,
} from '@/config/map.config';
import { routeStyle } from '@/config/mapStyle';
import type { EditorRoute, RouteFeature } from '@/stores/route.store';
import { getSegments } from '@/utils/geometry';

// While a surface section is shown (SurfaceFocusLayer), the rest of the route fades.
const faded: ExpressionSpecification = ['boolean', ['global-state', 'surfaceFocus'], false];
const surfaceColor: ExpressionSpecification = ['match', ['get', 'surface'],
  'paved', routeStyle.paved, 'likelyPaved', routeStyle.likelyPaved, 'rough', routeStyle.rough, 'unpaved', routeStyle.unpaved, routeStyle.unknown];
const routed: ExpressionSpecification = ['==', ['get', 'status'], 'routed'];
const arriving: ExpressionSpecification = ['boolean', ['get', 'arriving'], false];
const waiting: ExpressionSpecification = ['boolean', ['get', 'waiting'], false];

// Legs still being calculated show running dots once the answer takes a moment, so that quick answers leave no flash;
// a calculated leg then fades in. Each pattern moves the dots one step along; its units are line widths.
const waitingDelay = 300, fadeIn = 220;
const dot = 1, gap = 1.6, period = dot + gap, steps = 13;
const runningDots = Array.from({ length: steps }, (_, step) => {
  const offset = step * period / steps;
  return offset + dot <= period ? [0, offset, dot, period - offset - dot] : [offset + dot - period, period - dot, period - offset];
});

export function useSegmentedRoute() {
  // Segment ids per drawn leg feature, so that an edit only sends the changed legs to the map.
  let drawn = new Map<RouteFeature, number[]>();
  let nextId = 0;
  // Legs drawn as waiting, whose calculated successors fade in, and those fading in.
  let waitingLegs = new Set<string>();
  const arrivals = new Set<RouteFeature>();
  let settling: ReturnType<typeof setTimeout> | undefined, appearing: ReturnType<typeof setTimeout> | undefined;
  let forgetting: ReturnType<typeof setTimeout> | undefined, drawnFormer: RouteFeature[] | undefined;
  let dotsShown = false, frame = 0;
  const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;

  function segmentsOf(feature: RouteFeature, arrives: boolean, add: Feature<LineString>[]): number[] {
    return getSegments(feature).map(segment => {
      if (arrives) segment.properties.arriving = true;
      segment.id = nextId;
      add.push(segment);
      return nextId++;
    });
  }

  function addLayers(map: MaplibreMap, add: Feature<LineString>[]): void {
    const line = (id: string, source: string, filter: ExpressionSpecification | undefined, paint: LineLayerSpecification['paint']) =>
      map.addLayer({ id, type: 'line', source, ...(filter ? { filter } : {}), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint },
        MAP_LABELS_ANCHOR);
    map.addSource(SEGMENTS_FORMER_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource(SEGMENTS_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: add } });
    // The route an edit replaced, faded beneath the new one until that is calculated.
    line(SEGMENTS_FORMER_OUTLINE_LAYER, SEGMENTS_FORMER_SOURCE_ID, undefined, { 'line-color': routeStyle.outlineColor, 'line-width': 9, 'line-opacity': .35 });
    line(SEGMENTS_FORMER_LAYER, SEGMENTS_FORMER_SOURCE_ID, undefined, { 'line-color': surfaceColor, 'line-width': 5, 'line-opacity': .35 });
    const settled: ExpressionSpecification = ['all', routed, ['!', arriving]], arrivingRoute: ExpressionSpecification = ['all', routed, arriving];
    line(SEGMENTS_OUTLINE_LAYER, SEGMENTS_SOURCE_ID, settled, { 'line-color': routeStyle.outlineColor, 'line-width': 9, 'line-opacity': ['case', faded, .35, .95] });
    line(SEGMENTS_ROUTE_LAYER, SEGMENTS_SOURCE_ID, settled, { 'line-color': surfaceColor, 'line-width': 5, 'line-opacity': ['case', faded, .35, 1] });
    line(SEGMENTS_ARRIVING_OUTLINE_LAYER, SEGMENTS_SOURCE_ID, arrivingRoute, { 'line-color': routeStyle.outlineColor, 'line-width': 9, 'line-opacity': 0 });
    line(SEGMENTS_ARRIVING_LAYER, SEGMENTS_SOURCE_ID, arrivingRoute, { 'line-color': surfaceColor, 'line-width': 5, 'line-opacity': 0 });
    // A leg that failed, or leads to a stop without a street, stays a red dashed line.
    map.addLayer({ id: SEGMENTS_AIR_LAYER, type: 'line', source: SEGMENTS_SOURCE_ID,
      filter: ['all', ['==', ['get', 'status'], 'air'], ['!', waiting]], layout: { 'line-cap': 'round' },
      paint: { 'line-color': routeStyle.air, 'line-width': 4, 'line-dasharray': [2, 2] } }, MAP_LABELS_ANCHOR);
    map.addLayer({ id: SEGMENTS_WAITING_LAYER, type: 'line', source: SEGMENTS_SOURCE_ID,
      filter: ['all', ['==', ['get', 'status'], 'air'], waiting],
      paint: { 'line-color': routeStyle.waiting, 'line-width': 3.5, 'line-dasharray': [dot, gap], 'line-opacity': 0,
        'line-opacity-transition': { duration: 150, delay: 0 } } }, MAP_LABELS_ANCHOR);
    map.addLayer({ id: SEGMENTS_BASE_LAYER, type: 'line', source: SEGMENTS_SOURCE_ID,
      paint: { 'line-color': '#fff', 'line-width': 30, 'line-opacity': .01 } }, MAP_LABELS_ANCHOR);
  }

  // The legs fading in join the route; a new batch first completes the previous one.
  function settle(map: MaplibreMap): void {
    clearTimeout(settling);
    if (!arrivals.size) return;
    const remove: number[] = [], add: Feature<LineString>[] = [];
    for (const feature of arrivals) {
      const ids = drawn.get(feature);
      if (!ids) continue;
      remove.push(...ids);
      drawn.set(feature, segmentsOf(feature, false, add));
    }
    arrivals.clear();
    map.getSource<GeoJSONSource>(SEGMENTS_SOURCE_ID)?.updateData({ remove, add });
  }

  function fade(map: MaplibreMap): void {
    for (const layer of [SEGMENTS_ARRIVING_OUTLINE_LAYER, SEGMENTS_ARRIVING_LAYER]) {
      map.setPaintProperty(layer, 'line-opacity-transition', { duration: 0, delay: 0 });
      map.setPaintProperty(layer, 'line-opacity', 0);
    }
    // From 0 once the map has drawn that.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!map.getLayer(SEGMENTS_ARRIVING_LAYER)) return;
      for (const [layer, opacity] of [[SEGMENTS_ARRIVING_OUTLINE_LAYER, .95], [SEGMENTS_ARRIVING_LAYER, 1]] as const) {
        map.setPaintProperty(layer, 'line-opacity-transition', { duration: fadeIn, delay: 0 });
        map.setPaintProperty(layer, 'line-opacity', opacity);
      }
    }));
    settling = setTimeout(() => settle(map), fadeIn + 50);
  }

  function runDots(map: MaplibreMap, step = 0, last = 0): void {
    frame = requestAnimationFrame(time => {
      if (!dotsShown || !map.getLayer(SEGMENTS_WAITING_LAYER)) return;
      if (time - last >= 45) {
        map.setPaintProperty(SEGMENTS_WAITING_LAYER, 'line-dasharray', runningDots[step]);
        runDots(map, (step + 1) % steps, time);
      } else runDots(map, step, last);
    });
  }

  function showWaiting(map: MaplibreMap, any: boolean): void {
    if (any) {
      appearing ??= setTimeout(() => {
        dotsShown = true;
        map.setPaintProperty(SEGMENTS_WAITING_LAYER, 'line-opacity', .9);
        if (motion) runDots(map);
      }, waitingDelay);
      return;
    }
    clearTimeout(appearing);
    appearing = undefined;
    cancelAnimationFrame(frame);
    if (dotsShown && map.getLayer(SEGMENTS_WAITING_LAYER)) map.setPaintProperty(SEGMENTS_WAITING_LAYER, 'line-opacity', 0);
    dotsShown = false;
  }

  function renderSegments(map: MaplibreMap, route: EditorRoute | null, former: RouteFeature[] = []): void {
    const source = map.getSource<GeoJSONSource>(SEGMENTS_SOURCE_ID);
    // A new style has none of the route.
    if (!source) {
      drawn = new Map();
      arrivals.clear();
      showWaiting(map, false);
    }
    const features = route?.features ?? [];
    const arrives = (feature: RouteFeature) => motion && feature.properties.status === 'routed' && waitingLegs.has(feature.properties.legId);
    const arrived = features.some(feature => !drawn.has(feature) && arrives(feature));
    if (arrived) settle(map);
    const next = new Map<RouteFeature, number[]>();
    const add: Feature<LineString>[] = [];
    for (const feature of features) {
      let ids = drawn.get(feature);
      if (!ids) {
        ids = segmentsOf(feature, arrives(feature), add);
        if (arrives(feature)) arrivals.add(feature);
      }
      next.set(feature, ids);
    }
    waitingLegs = new Set(features.filter(feature => feature.properties.waiting).map(feature => feature.properties.legId));

    if (!source) addLayers(map, add);
    else {
      const remove = [...drawn].flatMap(([feature, ids]) => next.has(feature) ? [] : ids);
      for (const feature of arrivals) if (!next.has(feature)) arrivals.delete(feature);
      // Nothing recorded, e.g. after a remount: replace whatever the source holds.
      if (add.length || remove.length) source.updateData({ removeAll: !drawn.size, remove, add });
    }
    drawn = next;
    if (arrived) fade(map);
    showWaiting(map, waitingLegs.size > 0);
    if (former !== drawnFormer || !source) {
      const formerSource = map.getSource<GeoJSONSource>(SEGMENTS_FORMER_SOURCE_ID)!;
      const data = { type: 'FeatureCollection' as const, features: former.flatMap(getSegments) };
      clearTimeout(forgetting);
      // The replaced route goes as the new one fades in.
      if (!former.length && arrivals.size) forgetting = setTimeout(() => formerSource.setData(data), fadeIn);
      else formerSource.setData(data);
      drawnFormer = former;
    }
  }

  function dispose(): void {
    clearTimeout(settling);
    clearTimeout(appearing);
    clearTimeout(forgetting);
    cancelAnimationFrame(frame);
  }

  return { renderSegments, dispose };
}

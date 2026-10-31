import { onBeforeUnmount, watch, type Ref } from 'vue';
import type { Map as MaplibreMap, MapMouseEvent, Point } from 'maplibre-gl';
import type { RouteLeg } from '@/domain/route-model';
import { LOOP_OUTLINE_LAYER, SEGMENTS_BASE_LAYER } from '@/config/map.config';
import { consumeRouteDragClick } from '@/composables/useRouteDragging';
import { useRouteStore } from '@/stores/route.store';
import { useLoopSuggestionsStore } from '@/stores/loop-suggestions.store';
import { cyclingPoiLayers, poiHitBox } from '@/config/cycling-overlays';
import { useStreetViewStore } from '@/stores/street-view.store';
import { useOfflineAreasStore } from '@/stores/offline-areas.store';
import { routePointNear } from '@/composables/useStreetViewMap';

// The legs' vertex nearest to a point on the screen, within reach of a fingertip. Only vertices in the reach's
// geographic box are projected, so that long routes stay quick under a moving pointer.
function vertexNear(map: MaplibreMap, legs: RouteLeg[], { x, y }: Point): { leg: RouteLeg; index: number } | null {
  const reach = 30, corners = [[x - reach, y - reach], [x + reach, y - reach], [x - reach, y + reach], [x + reach, y + reach]]
    .map(corner => map.unproject(corner as [number, number]));
  const [west, east] = [Math.min(...corners.map(c => c.lng)), Math.max(...corners.map(c => c.lng))];
  const [south, north] = [Math.min(...corners.map(c => c.lat)), Math.max(...corners.map(c => c.lat))];
  let nearest: { leg: RouteLeg; index: number } | null = null, best = reach ** 2;
  for (const leg of legs) {
    leg.coordinates.forEach(([lon, lat], index) => {
      if (lon < west || lon > east || lat < south || lat > north) return;
      const p = map.project([lon, lat]), distance = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (distance < best) [nearest, best] = [{ leg, index }, distance];
    });
  }
  return nearest;
}

export function useMapInteractions(mapRef: Ref<MaplibreMap | null>): void {
  const routeStore = useRouteStore();
  const streetView = useStreetViewStore();
  const loops = useLoopSuggestionsStore();
  const offline = useOfflineAreasStore();

  function onClick(event: MapMouseEvent): void {
    const map = mapRef.value;
    // Choosing offline areas takes the map's clicks (OfflineAreasLayer).
    if (!map || offline.active) return;
    if (streetView.picking) { streetView.show(routePointNear(map, event.point) ?? [event.lngLat.lng, event.lngLat.lat]); return; }
    if (routeStore.surfaceReporting) {
      // A started stretch ends on its own leg; otherwise any planned leg can start one.
      const pick = routeStore.surfacePicking;
      const legs = pick?.end === null ? [pick.leg] : Object.values(routeStore.legs).filter(leg => leg.status === 'routed' && !leg.recorded);
      const near = vertexNear(map, legs, event.point);
      if (near) routeStore.pickSurfacePoint(near.leg.id, near.index);
      return;
    }
    if (consumeRouteDragClick(map, event.point)) return;
    if (event.originalEvent.target instanceof HTMLElement && event.originalEvent.target.closest('.maplibregl-marker')) return;
    // While loops are offered, a click or tap near one shows it as the route, and elsewhere sets no stop.
    if (loops.suggestions?.length) {
      const [loop] = map.getLayer(LOOP_OUTLINE_LAYER) ? map.queryRenderedFeatures(poiHitBox(event.point), { layers: [LOOP_OUTLINE_LAYER] }) : [];
      if (typeof loop?.properties.index === 'number') loops.toggle(loop.properties.index);
      return;
    }
    const poiLayers = cyclingPoiLayers.filter(id => map.getLayer(id));
    if (poiLayers.length && map.queryRenderedFeatures(poiHitBox(event.point), { layers: poiLayers }).length) return;
    const coord: [number, number] = [event.lngLat.lng, event.lngLat.lat];

    try {
      if (map.getLayer(SEGMENTS_BASE_LAYER)) {
        const feature = map.queryRenderedFeatures(event.point, { layers: [SEGMENTS_BASE_LAYER] })[0];
        const { fromId, toId } = feature?.properties ?? {};
        if (typeof fromId === 'string' && typeof toId === 'string') {
          routeStore.insertWaypointOnRoute(fromId, toId, coord);
          return;
        }
      }
      routeStore.addWaypointByClick(coord);
    } catch (error) {
      console.error('Kartenklick konnte nicht verarbeitet werden:', error);
      routeStore.errorMessage = error instanceof Error ? error.message : 'Der Punkt konnte nicht gesetzt werden.';
    }
  }

  let frame = 0, pointer: Point | null = null;
  function onMouseMove(event: MapMouseEvent): void {
    if (routeStore.surfacePicking?.end !== null) return;
    pointer = event.point;
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      const pick = routeStore.surfacePicking;
      if (mapRef.value && pick && pointer) routeStore.hoverSurfacePoint(vertexNear(mapRef.value, [pick.leg], pointer)?.index ?? null);
    });
  }

  watch(mapRef, (map, previous) => {
    previous?.off('click', onClick);
    previous?.off('mousemove', onMouseMove);
    map?.on('click', onClick);
    map?.on('mousemove', onMouseMove);
  }, { immediate: true });
  onBeforeUnmount(() => {
    mapRef.value?.off('click', onClick);
    mapRef.value?.off('mousemove', onMouseMove);
    cancelAnimationFrame(frame);
  });
}

import { onBeforeUnmount, watch, type Ref } from 'vue';
import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import { LOOP_OUTLINE_LAYER, SEGMENTS_BASE_LAYER } from '@/config/map.config';
import { consumeRouteDragClick } from '@/composables/useRouteDragging';
import { useRouteStore } from '@/stores/route.store';
import { useLoopSuggestionsStore } from '@/stores/loop-suggestions.store';
import { cyclingPoiLayers, poiHitBox } from '@/config/cycling-overlays';
import { useStreetViewStore } from '@/stores/street-view.store';
import { routePointNear } from '@/composables/useStreetViewMap';

export function useMapInteractions(mapRef: Ref<MaplibreMap | null>): void {
  const routeStore = useRouteStore();
  const streetView = useStreetViewStore();
  const loops = useLoopSuggestionsStore();

  function onClick(event: MapMouseEvent): void {
    const map = mapRef.value;
    if (!map) return;
    if (streetView.picking) { streetView.show(routePointNear(map, event.point) ?? [event.lngLat.lng, event.lngLat.lat]); return; }
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

  watch(mapRef, (map, previous) => {
    previous?.off('click', onClick);
    map?.on('click', onClick);
  }, { immediate: true });
  onBeforeUnmount(() => mapRef.value?.off('click', onClick));
}

import { onBeforeUnmount, watch, type Ref } from 'vue';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { Coord, Waypoint } from '@/domain/route-model';
import { useMapMarkers } from '@/composables/useMapMarkers';
import { useRouteStore } from '@/stores/route.store';

export function useMarkerWatches(mapRef: Ref<MaplibreMap | null>): void {
  const routeStore = useRouteStore();
  const { createWaypointMarkers, createShapingMarkers, clearAllMarkers } = useMapMarkers(mapRef);

  watch(
    [mapRef, () => routeStore.waypoints.map((point) => ({ ...point, coord: point.coord && [...point.coord] }))],
    ([map]) => {
      if (!map) return;
      const placed = routeStore.waypoints.filter((point): point is Waypoint & { coord: Coord } => point.coord !== null);
      createWaypointMarkers(placed);
    },
    { immediate: true },
  );

  watch(
    [mapRef, () => routeStore.shapingPoints.map((point) => ({ ...point, coord: [...point.coord] }))],
    ([map]) => {
      if (map) createShapingMarkers(routeStore.shapingPoints);
    },
    { immediate: true },
  );

  onBeforeUnmount(clearAllMarkers);
}

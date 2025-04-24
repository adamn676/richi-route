import { watch, onBeforeUnmount, type Ref } from "vue";
import type maplibregl from "maplibre-gl";
import { useMapMarkers } from "@/composables/useMapMarkers";
import type { RouteStore } from "@/stores/route.store";

export function useMarkerWatches(
  mapRef: Ref<maplibregl.Map | null>,
  routeStore: RouteStore
) {
  const { createWaypointMarkers, createShapingMarkers, clearMarkers } =
    useMapMarkers(mapRef);

  watch(
    () => routeStore.waypoints.slice(),
    (wps) => {
      if (!mapRef.value) return;
      createWaypointMarkers(wps, { draggable: true });
    },
    { immediate: true }
  );

  watch(
    () => routeStore.shapingPoints.slice(),
    (sps) => {
      if (!mapRef.value) return;
      const coords = sps.map((sp) => sp.coord);
      createShapingMarkers(coords, { draggable: true });
    },
    { immediate: true }
  );

  onBeforeUnmount(() => {
    clearMarkers();
  });
}

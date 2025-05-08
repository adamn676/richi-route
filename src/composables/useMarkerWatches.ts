// import { watch, onBeforeUnmount, type Ref } from "vue";
// import type maplibregl from "maplibre-gl";
// import { useMapMarkers } from "@/composables/useMapMarkers";
// import type { RouteStore } from "@/stores/route.store";

// export function useMarkerWatches(
//   mapRef: Ref<maplibregl.Map | null>,
//   routeStore: RouteStore
// ) {
//   const { createWaypointMarkers, createShapingMarkers, clearMarkers } =
//     useMapMarkers(mapRef);

//   watch(
//     () => routeStore.waypoints.slice(),
//     (wps) => {
//       if (!mapRef.value) return;
//       createWaypointMarkers(wps, { draggable: true });
//     },
//     { immediate: true }
//   );

//   watch(
//     () => routeStore.shapingPoints.slice(),
//     (sps) => {
//       if (!mapRef.value) return;
//       const coords = sps.map((sp) => sp.coord);
//       createShapingMarkers(coords, { draggable: true });
//     },
//     { immediate: true }
//   );

//   onBeforeUnmount(() => {
//     clearMarkers();
//   });
// }

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

  // 1) Watch the store’s waypoints → createWaypointMarkers
  watch(
    // Generate an array of coordinate pairs to detect changes
    () => routeStore.waypoints.map((wp) => [...wp.coords] as [number, number]),
    (coordArrays) => {
      if (!mapRef.value) return;
      // Pass [lng, lat] arrays to createWaypointMarkers
      createWaypointMarkers(coordArrays, { draggable: true });
    },
    { immediate: true }
  );

  // 2) Watch the store’s shapingPoints → createShapingMarkers
  watch(
    // Similarly generate an array of coordinate pairs
    () =>
      routeStore.shapingPoints.map((sp) => [...sp.coord] as [number, number]),
    (shapingCoordArrays) => {
      if (!mapRef.value) return;
      createShapingMarkers(shapingCoordArrays, { draggable: true });
    },
    { immediate: true }
  );

  // Clear all markers when component unmounts
  onBeforeUnmount(() => {
    clearMarkers();
  });
}

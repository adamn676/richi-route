// // src/composables/useMapInteractions.ts

// import { ref, watch } from "vue";
// import type { Ref } from "vue";
// import type maplibregl from "maplibre-gl";
// import { SEGMENTS_BASE_LAYER } from "@/config/map.config";
// import { useNotification } from "@/composables/useNotification";
// import type { RouteStore } from "@/stores/route.store";

// export function useMapInteractions(
//   mapRef: Ref<maplibregl.Map | null>,
//   routeStore: RouteStore
// ) {
//   const notify = useNotification();
//   const isCalc = ref(false);

//   /**
//    * Defines how to handle map clicks:
//    * - Check if user clicked on the route segment => insert a waypoint
//    * - Otherwise => new waypoint
//    */
//   function setupClickHandler(m: maplibregl.Map) {
//     m.on("click", async (e) => {
//       console.log("Clicked map, e.lngLat=", e.lngLat);
//       // 1) If clicked on an existing segment
//       if (routeStore.route && m.getLayer(SEGMENTS_BASE_LAYER)) {
//         const feats = m.queryRenderedFeatures(e.point, {
//           layers: [SEGMENTS_BASE_LAYER],
//         });
//         if (feats.length) {
//           const idx = (feats[0].properties as any)?.idx as number;
//           await routeStore.insertWaypoint(idx + 1, [
//             e.lngLat.lng,
//             e.lngLat.lat,
//           ]);
//           return;
//         }
//       }

//       // 2) Fallback: new hard stop
//       if (isCalc.value) {
//         notify.info("Please wait for calculation...");
//         return;
//       }
//       isCalc.value = true;
//       try {
//         // The new approach: if Start is still [0,0], set that. If End is still [0,0], set that. Otherwise add a new waypoint.
//         const clickCoord = [e.lngLat.lng, e.lngLat.lat] as [number, number];

//         // Pull out the first two coords (start, end)
//         const startCoord = routeStore.waypoints[0].coords;
//         const endCoord = routeStore.waypoints[1].coords;

//         // If start is still [0,0], update it
//         if (startCoord[0] === 0 && startCoord[1] === 0) {
//           console.log("Replacing Start (index 0) with ", clickCoord);
//           await routeStore.updateWaypoint(0, clickCoord);
//           return;
//         }

//         // Else if end is still [0,0], update it
//         if (endCoord[0] === 0 && endCoord[1] === 0) {
//           console.log("Replacing End (index 1) with ", clickCoord);
//           await routeStore.updateWaypoint(1, clickCoord);
//           return;
//         }

//         // Otherwise, we do a brand new waypoint
//         await routeStore.addWaypoint([e.lngLat.lng, e.lngLat.lat]);
//       } finally {
//         // re-enable clicks after short delay
//         setTimeout(() => (isCalc.value = false), 500);
//       }
//     });
//   }

//   /**
//    * Whenever mapRef.value becomes a real map, attach the click handler
//    */
//   watch(
//     () => mapRef.value,
//     (m) => {
//       if (m) setupClickHandler(m);
//     },
//     { immediate: true }
//   );

//   return {
//     isCalc, // optional: maybe used for debugging or other watchers
//   };
// }

// src/composables/useMapInteractions.ts
import { ref, watch } from "vue";
import type { Ref } from "vue";
import type maplibregl from "maplibre-gl";
import { SEGMENTS_BASE_LAYER, DIST_ROUTE } from "@/config/map.config"; // Added DIST_ROUTE
import { useNotification } from "@/composables/useNotification";
import { useRouteStore } from "@/stores/route.store"; // Use direct import
import * as turf from "@turf/turf"; // For pointToLineDistance

export function useMapInteractions(
  mapRef: Ref<maplibregl.Map | null>
  // routeStore: RouteStore // No longer pass as prop, use direct import
) {
  const routeStore = useRouteStore(); // Use the store directly
  const notify = useNotification();
  const isProcessingClick = ref(false);

  function setupClickHandler(m: maplibregl.Map) {
    m.on("click", async (e) => {
      if (isProcessingClick.value) {
        // notify.info("Processing previous action..."); // Can be noisy
        return;
      }
      isProcessingClick.value = true;
      console.log("Map clicked at LngLat:", e.lngLat);

      const clickPoint = turf.point([e.lngLat.lng, e.lngLat.lat]);

      // 1. Check if click is on an existing route segment to insert a *hard point*
      if (
        routeStore.route &&
        routeStore.route.features.length > 0 &&
        m.getLayer(SEGMENTS_BASE_LAYER)
      ) {
        // Query features directly on the map for the segment layer
        const features = m.queryRenderedFeatures(e.point, {
          layers: [SEGMENTS_BASE_LAYER],
        });

        if (features.length > 0) {
          const segmentFeature = features[0]; // The segment itself
          // The 'idx' property on the segment refers to its order in the *rendered segments*
          // This idx corresponds to the Nth segment of the *current route*.
          // If the route is A-B-C, segment 0 is A-B, segment 1 is B-C.
          // Clicking on segment 0 (A-B) should insert a point between A and B.
          // So, the new point becomes the (idx + 1)-th waypoint in the store's waypoints array.

          const segmentIndex = segmentFeature.properties?.idx as number;

          if (typeof segmentIndex === "number" && segmentIndex >= 0) {
            // Check distance to the actual line geometry of the segment
            const line = segmentFeature.geometry;
            if (line.type === "LineString") {
              const distance = turf.pointToLineDistance(clickPoint, line, {
                units: "meters",
              });
              console.log(`Distance to segment ${segmentIndex}: ${distance}m`);
              if (distance < DIST_ROUTE) {
                console.log(
                  `Clicked on segment ${segmentIndex}. Inserting waypoint after existing waypoint at index ${segmentIndex}.`
                );
                await routeStore.insertWaypointOnRoute(segmentIndex + 1, [
                  e.lngLat.lng,
                  e.lngLat.lat,
                ]);
                isProcessingClick.value = false;
                return;
              }
            }
          }
        }
      }

      // 2. If not on a segment, handle as adding/updating Start/End/Via waypoint
      console.log("Not on a segment, adding/updating waypoint by click.");
      await routeStore.addWaypointByClick([e.lngLat.lng, e.lngLat.lat]);

      // Short delay to prevent rapid-fire clicks overwhelming the system
      setTimeout(() => {
        isProcessingClick.value = false;
      }, 300);
    });
  }

  watch(
    () => mapRef.value,
    (m) => {
      if (m && !m.listens("click")) {
        // Ensure handler is attached only once
        setupClickHandler(m);
      }
    },
    { immediate: true }
  );

  return {
    isProcessingClick,
  };
}

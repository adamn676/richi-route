// import { ref, watch } from "vue";
// import type { Ref } from "vue";
// import maplibregl from "maplibre-gl";
// import type { Map } from "maplibre-gl";
// import { useRouteStore, WaypointType } from "../stores/route.store";

// export function useRouteDragging(map: Ref<Map | null>) {
//   const routeStore = useRouteStore();
//   const isDragging = ref(false);
//   const draggedPointId = ref<string | null>(null);

//   // Handle map click to create waypoints or interact with route
//   const handleMapClick = (e: maplibregl.MapMouseEvent) => {
//     if (!map.value) return;

//     const coordinates: [number, number] = [e.lngLat.lng, e.lngLat.lat];

//     // Check if click happened on an existing waypoint
//     const features = map.value.queryRenderedFeatures(e.point, {
//       layers: ["waypoints-markers"],
//     });

//     if (features.length > 0 && features[0].properties) {
//       // Clicked on a waypoint
//       const id = features[0].properties.id;
//       return; // Handled by the waypoint's own click handler
//     }

//     // Check if click happened on route
//     const routeFeatures = map.value.queryRenderedFeatures(e.point, {
//       layers: ["route-line"],
//     });

//     if (routeFeatures.length > 0) {
//       // Clicked on the route - create a hard waypoint
//       routeStore.createHardPointOnRoute(coordinates);
//     } else {
//       // General map click - follow waypoint creation logic
//       routeStore.handleMapClick(coordinates);
//     }
//   };

//   // Handle mouse move over route to highlight segments
//   const handleMouseMove = (e: maplibregl.MapMouseEvent) => {
//     if (!map.value || !routeStore.route) return;

//     const point = e.point;
//     const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];

//     // Update hover point
//     routeStore.setHoverPoint(lngLat);

//     // Check if mouse is over the route
//     const routeFeatures = map.value.queryRenderedFeatures(point, {
//       layers: ["route-line"],
//     });

//     if (routeFeatures.length > 0) {
//       // Mouse is over the route - highlight the segment
//       // In a real application, you would identify the specific segment
//       map.value.getCanvas().style.cursor = "pointer";

//       // Find the nearest segment based on the lngLat
//       // This is a simplified approach - in reality you'd use turf.js
//       // to accurately find the nearest point on the route
//       if (routeStore.segments.length > 0) {
//         const firstSegment = routeStore.segments[0].id;
//         routeStore.setHighlightedSegment(firstSegment);

//         // Simulate hover on the route segment by updating the layer style
//         if (map.value.getLayer("route-line")) {
//           map.value.setPaintProperty("route-line", "line-color", [
//             "case",
//             ["==", ["get", "id"], firstSegment],
//             "#F59E0B", // amber-500 for highlighted segment
//             "#3B82F6", // blue-500 for normal segments
//           ]);
//         }
//       }
//     } else {
//       // Mouse is not over the route - reset highlights
//       map.value.getCanvas().style.cursor = "";
//       routeStore.setHighlightedSegment(null);

//       // Reset route line color
//       if (map.value.getLayer("route-line")) {
//         map.value.setPaintProperty("route-line", "line-color", "#3B82F6");
//       }
//     }
//   };

//   // Initialize map event handlers
//   watch(
//     () => map.value,
//     (mapInstance) => {
//       if (mapInstance) {
//         mapInstance.on("load", () => {
//           // Add click handler for waypoint creation
//           mapInstance.on("click", handleMapClick);

//           // Add mousemove handler for segment highlighting
//           mapInstance.on("mousemove", handleMouseMove);

//           // Setup dragging functionality
//           setupDragging(mapInstance);
//         });
//       }
//     }
//   );

//   // Setup dragging functionality for waypoints
//   const setupDragging = (mapInstance: maplibregl.Map) => {
//     let draggedWaypoint: string | null = null;

//     // Mouse down on waypoint
//     mapInstance.on("mousedown", "waypoints-markers", (e) => {
//       if (e.features && e.features[0].properties) {
//         // Prevent the map from panning
//         e.preventDefault();

//         // Get waypoint ID
//         draggedWaypoint = e.features[0].properties.id;
//         draggedPointId.value = draggedWaypoint;

//         // Set cursor to grabbing
//         mapInstance.getCanvas().style.cursor = "grabbing";

//         // Start dragging in store
//         routeStore.startDragging(draggedWaypoint);
//         isDragging.value = true;

//         // Add mousemove and mouseup events
//         mapInstance.on("mousemove", onWaypointDrag);
//         mapInstance.on("mouseup", onWaypointDragEnd);
//       }
//     });

//     // Dragging waypoint
//     const onWaypointDrag = (e: maplibregl.MapMouseEvent) => {
//       if (isDragging.value && draggedWaypoint) {
//         // Update the waypoint position
//         const newCoords: [number, number] = [e.lngLat.lng, e.lngLat.lat];
//         routeStore.updateDraggedPoint(newCoords);
//       }
//     };

//     // End dragging waypoint
//     const onWaypointDragEnd = () => {
//       // Clean up the mousemove and mouseup events
//       mapInstance.off("mousemove", onWaypointDrag);
//       mapInstance.off("mouseup", onWaypointDragEnd);

//       // Reset cursor
//       mapInstance.getCanvas().style.cursor = "";

//       // End dragging in store
//       routeStore.stopDragging();
//       isDragging.value = false;
//       draggedWaypoint = null;
//       draggedPointId.value = null;
//     };

//     // Hover over waypoints
//     mapInstance.on("mouseenter", "waypoints-markers", () => {
//       if (!isDragging.value) {
//         mapInstance.getCanvas().style.cursor = "grab";
//       }
//     });

//     mapInstance.on("mouseleave", "waypoints-markers", () => {
//       if (!isDragging.value) {
//         mapInstance.getCanvas().style.cursor = "";
//       }
//     });
//   };

//   return {
//     isDragging,
//     draggedPointId,
//   };
// }

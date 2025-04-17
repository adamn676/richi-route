// import { ref, computed, watch, type Ref } from "vue";
// import maplibregl from "maplibre-gl";
// import type { Map } from "maplibre-gl";
// import { useRouteStore, WaypointType } from "@/stores/route.store";
// import { RouteService } from "@/services/route.service";

// export function useRouteCalculation(map: Ref<Map | null>) {
//   const routeStore = useRouteStore();
//   const isCalculating = ref(false);
//   const error = ref<string | null>(null);

//   // Watch for changes to the waypoints
//   watch(
//     () => routeStore.waypoints,
//     async (waypoints) => {
//       if (waypoints.length >= 2) {
//         await calculateRoute();
//       }
//     },
//     { deep: true }
//   );

//   const calculateRoute = async () => {
//     if (routeStore.waypoints.length < 2) {
//       return;
//     }

//     isCalculating.value = true;
//     error.value = null;

//     try {
//       const coordinates = routeStore.waypoints.map((wp) => wp.coordinates);
//       const result = await RouteService.calculateRoute(coordinates);

//       if (result.features && result.features.length > 0) {
//         // Update the route store with the calculated route
//         routeStore.route = result.features[0];
//         routeStore.createRouteSegments();
//       } else {
//         throw new Error("No route found");
//       }
//     } catch (err) {
//       console.error("Error calculating route:", err);
//       error.value = "Failed to calculate route. Please try again.";
//     } finally {
//       isCalculating.value = false;
//     }
//   };

//   // Display the route on the map
//   const displayRoute = () => {
//     if (!map.value || !routeStore.route) return;

//     const mapInstance = map.value;

//     // Check if we already have the route source
//     if (!mapInstance.getSource("route")) {
//       // Add the route source
//       mapInstance.addSource("route", {
//         type: "geojson",
//         data: {
//           type: "Feature",
//           properties: {},
//           geometry: {
//             type: "LineString",
//             coordinates: [],
//           },
//         },
//       });

//       // Add the route layer
//       mapInstance.addLayer({
//         id: "route-line",
//         type: "line",
//         source: "route",
//         layout: {
//           "line-join": "round",
//           "line-cap": "round",
//         },
//         paint: {
//           "line-color": "#3B82F6", // Blue color for the route
//           "line-width": 6,
//           "line-opacity": 0.8,
//         },
//       });

//       // Add the route outline layer for better visibility
//       mapInstance.addLayer(
//         {
//           id: "route-outline",
//           type: "line",
//           source: "route",
//           layout: {
//             "line-join": "round",
//             "line-cap": "round",
//           },
//           paint: {
//             "line-color": "#ffffff",
//             "line-width": 10,
//             "line-opacity": 0.4,
//           },
//           filter: ["==", "$type", "LineString"],
//         },
//         "route-line"
//       );
//     }

//     // Update the route source
//     const source = mapInstance.getSource("route") as maplibregl.GeoJSONSource;
//     source.setData(routeStore.route);

//     // Fit the map to the route bounds
//     const routeCoordinates = routeStore.route.geometry.coordinates;

//     if (routeCoordinates.length > 1) {
//       const bounds = new maplibregl.LngLatBounds(
//         routeCoordinates[0] as [number, number],
//         routeCoordinates[0] as [number, number]
//       );

//       // Extend the bounds to include all coordinates
//       for (const coord of routeCoordinates) {
//         bounds.extend(coord as [number, number]);
//       }

//       mapInstance.fitBounds(bounds, {
//         padding: 40,
//         maxZoom: 15,
//         duration: 1000,
//       });
//     }
//   };

//   // Display waypoints on the map
//   const displayWaypoints = () => {
//     if (!map.value) return;

//     const mapInstance = map.value;

//     // Check if we already have the waypoints source
//     if (!mapInstance.getSource("waypoints")) {
//       // Add the waypoints source
//       mapInstance.addSource("waypoints", {
//         type: "geojson",
//         data: {
//           type: "FeatureCollection",
//           features: [],
//         },
//       });

//       // Add a layer for the start and end markers
//       mapInstance.addLayer({
//         id: "waypoints-markers",
//         type: "circle",
//         source: "waypoints",
//         paint: {
//           "circle-radius": 10,
//           "circle-color": [
//             "match",
//             ["get", "type"],
//             "start",
//             "#22C55E", // green-500
//             "end",
//             "#EF4444", // red-500
//             "hard",
//             "#3B82F6", // blue-500
//             "soft",
//             "#F59E0B", // amber-500
//             "#9CA3AF", // gray-400 default
//           ],
//           "circle-stroke-width": 2,
//           "circle-stroke-color": "#ffffff",
//         },
//         filter: [
//           "in",
//           ["get", "type"],
//           ["literal", ["start", "end", "hard", "soft"]],
//         ],
//       });

//       // Add a layer for labels
//       mapInstance.addLayer({
//         id: "waypoints-labels",
//         type: "symbol",
//         source: "waypoints",
//         layout: {
//           "text-field": ["get", "name"],
//           "text-size": 12,
//           "text-offset": [0, 1.5],
//           "text-anchor": "top",
//         },
//         paint: {
//           "text-color": "#374151",
//           "text-halo-color": "#ffffff",
//           "text-halo-width": 2,
//         },
//         filter: ["in", ["get", "type"], ["literal", ["start", "end"]]],
//       });
//     }

//     // Convert waypoints to GeoJSON
//     const features = routeStore.waypoints.map((waypoint) => ({
//       type: "Feature" as const,
//       geometry: {
//         type: "Point" as const,
//         coordinates: waypoint.coordinates,
//       },
//       properties: {
//         id: waypoint.id,
//         name: waypoint.name,
//         type: waypoint.type,
//         address: waypoint.address,
//         isEphemeral: waypoint.isEphemeral,
//       },
//     }));

//     // Update the waypoints source
//     const source = mapInstance.getSource(
//       "waypoints"
//     ) as maplibregl.GeoJSONSource;
//     source.setData({
//       type: "FeatureCollection",
//       features,
//     });
//   };

//   // Watch for route changes to update the map
//   watch(
//     () => routeStore.route,
//     (route) => {
//       if (route && map.value) {
//         displayRoute();
//         displayWaypoints();
//       }
//     }
//   );

//   // Watch for waypoint changes to update the map
//   watch(
//     () => routeStore.waypoints,
//     () => {
//       if (map.value) {
//         displayWaypoints();
//       }
//     },
//     { deep: true }
//   );

//   // Initialize map layers once the map is loaded
//   watch(
//     () => map.value,
//     (mapInstance) => {
//       if (mapInstance) {
//         mapInstance.on("load", () => {
//           // If we already have route data, display it
//           if (routeStore.route) {
//             displayRoute();
//           }

//           // Display any existing waypoints
//           displayWaypoints();
//         });
//       }
//     }
//   );

//   return {
//     isCalculating,
//     error,
//     calculateRoute,
//   };
// }

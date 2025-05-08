// src/composables/useMapMarkers.ts
import { type Ref } from "vue";
import { createApp } from "vue";
import maplibregl from "maplibre-gl";
import CustomMarker from "@/components/map/CustomMarker.vue";
import type { Coord } from "@/services/maptiler.service";

// Create a custom marker element using Vue component
function createCustomMarkerElement(
  type: "waypoint" | "shaping",
  icon?: string,
  number?: number
) {
  // Create a container div
  const el = document.createElement("div");

  // Create a Vue app
  const app = createApp(CustomMarker, {
    type,
    icon: icon || (type === "waypoint" ? "location_on" : "drag_indicator"),
    size: type === "waypoint" ? 36 : 28,
    iconSize: type === "waypoint" ? 6 : 4,
    iconColor: type === "shaping" ? "text-indigo-900" : "text-white",
    number,
  });

  // Mount the Vue app to the container
  app.mount(el);

  return el;
}

export function useMapMarkers(map: Ref<maplibregl.Map | null>) {
  const waypointMarkers: maplibregl.Marker[] = [];
  const shapingMarkers: maplibregl.Marker[] = [];

  // Clean up all markers
  const clearMarkers = () => {
    [...waypointMarkers, ...shapingMarkers].forEach((marker) =>
      marker.remove()
    );
    waypointMarkers.length = 0;
    shapingMarkers.length = 0;
  };

  // Create waypoint markers
  const createWaypointMarkers = (
    waypoints: Coord[],
    options: { draggable?: boolean } = {}
  ) => {
    console.log("createWaypointMarkers - waypoints:", waypoints);
    // Remove old markers
    waypointMarkers.forEach((marker) => marker.remove());
    waypointMarkers.length = 0;

    // Create new markers
    waypoints.forEach((coord, index) => {
      console.log(`waypoint[${index}] coords=`, coord);
      if (!map.value) return;

      const el = createCustomMarkerElement(
        "waypoint",
        "location_on",
        index + 1
      );

      const marker = new maplibregl.Marker({
        element: el,
        draggable: options.draggable ?? true,
      })
        .setLngLat(coord)
        .addTo(map.value);

      waypointMarkers.push(marker);

      // Add drag events if needed
      if (options.draggable) {
        // Add drag end handler here if needed
      }
    });

    return waypointMarkers;
  };

  // Create shaping point markers
  const createShapingMarkers = (
    shapingPoints: Coord[],
    options: { draggable?: boolean } = {}
  ) => {
    // Remove old markers
    shapingMarkers.forEach((marker) => marker.remove());
    shapingMarkers.length = 0;

    // Create new markers
    shapingPoints.forEach((coord, _index) => {
      if (!map.value) return;

      const el = createCustomMarkerElement("shaping", "drag_indicator");

      const marker = new maplibregl.Marker({
        element: el,
        draggable: options.draggable ?? true,
      })
        .setLngLat(coord)
        .addTo(map.value);

      shapingMarkers.push(marker);

      // Add drag events if needed
      if (options.draggable) {
        // Add drag end handler here if needed
      }
    });

    return shapingMarkers;
  };

  // Create a temporary marker (for dragging)
  const createTempMarker = (
    coord: Coord,
    type: "waypoint" | "shaping" = "shaping"
  ) => {
    if (!map.value) return null;

    const el = createCustomMarkerElement(
      type,
      type === "waypoint" ? "location_on" : "drag_handle"
    );

    const marker = new maplibregl.Marker({
      element: el,
      draggable: false,
    })
      .setLngLat(coord)
      .addTo(map.value);

    return marker;
  };

  return {
    waypointMarkers,
    shapingMarkers,
    clearMarkers,
    createWaypointMarkers,
    createShapingMarkers,
    createTempMarker,
  };
}

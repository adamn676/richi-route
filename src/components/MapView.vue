<template>
  <div class="relative w-full">
    <div ref="mapContainer" class="w-full h-full"></div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, shallowRef, watch } from "vue";
import maplibregl, {
  Map as MaplibreMap,
  Marker,
  MapMouseEvent,
  type PointLike,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import {
  lineString,
  point,
  nearestPointOnLine,
  distance as turfDistance,
} from "@turf/turf";

import { useRouteStore } from "@/stores/routeStore";
const routeStore = useRouteStore();

// For store-based markers
const markersMap = new Map<string, Marker>();

// Single ephemeral marker
let ephemeralMarker: Marker | null = null;
let ephemeralIsVisible = false;
let ephemeralIsCommitted = false;

// Track ephemeral dragging & any dragging
let isDraggingEphemeral = false;
let isDraggingAnyMarker = false;

// Constants for route layer, etc.
const ROUTE_LAYER_ID = "routeLayer";
const ROUTE_SOURCE_ID = "routeSource";
const mapContainer = ref<HTMLDivElement | null>(null);
const mapInstance = shallowRef<MaplibreMap | null>(null);
const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;

onMounted(() => {
  if (!mapContainer.value) return;

  mapInstance.value = new maplibregl.Map({
    container: mapContainer.value,
    style: `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`,
    center: [15.4417, 47.0679],
    zoom: 15,
  });

  mapInstance.value.addControl(new maplibregl.NavigationControl(), "top-right");

  // Create ephemeral marker once during initialization
  // We'll create it immediately but not add it to the map yet
  ephemeralMarker = new maplibregl.Marker({
    draggable: true,
    color: "#0d6efd",
    scale: 0.8,
  });

  // Set up all event handlers for the ephemeral marker
  ephemeralMarker.on("dragstart", onEphemeralDragStart);
  ephemeralMarker.on("drag", onEphemeralDrag);
  ephemeralMarker.on("dragend", onEphemeralDragEnd);

  // Initialize state
  ephemeralIsVisible = false;
  ephemeralIsCommitted = false;

  mapInstance.value.on("load", () => {
    setupMarkers();
    if (routeStore.routeData) {
      drawRouteLine(routeStore.routeData);
    }
  });

  if (!mapInstance.value) return;

  // Map events
  mapInstance.value.on("click", onMapClick);
  mapInstance.value.on("contextmenu", onContextMenu);
  mapInstance.value.on("mousemove", onMapMouseMove);
  mapInstance.value.on("mousedown", onMapMouseDown);
  mapInstance.value.on("mouseup", onMapMouseUp);
});

/* ------------------------------------------------------------------
   #1 onMapClick => place start, end, or move end if off-route
------------------------------------------------------------------ */
function onMapClick(e: MapMouseEvent) {
  if (!mapInstance.value) return;
  const { lng, lat } = e.lngLat;

  const startWp = routeStore.getWaypointById("start");
  const endWp = routeStore.getWaypointById("end");

  if (!startWp) {
    routeStore.addWaypoint({ id: "start", coord: [lng, lat] });
    setupMarkers();
    return;
  }
  if (!endWp) {
    routeStore.addWaypoint({ id: "end", coord: [lng, lat] });
    setupMarkers();
    routeStore.calculateRoute();
    return;
  }

  // If we have both start & end => check if user clicked route
  const routeFeatures = getFeaturesNearPoint(e.point, 15, [ROUTE_LAYER_ID]);
  if (routeFeatures.length === 0) {
    // user clicked off-route => move end
    routeStore.updateWaypoint("end", [lng, lat]);
    setupMarkers();
    routeStore.calculateRoute();
  }
}

/* ------------------------------------------------------------------
   #2 contextmenu => remove intermediate
------------------------------------------------------------------ */
function onContextMenu(e: MapMouseEvent) {
  if (!mapInstance.value) return;
  const waypointId = findWaypointNearClick(e.point, 10);
  if (waypointId && waypointId !== "start" && waypointId !== "end") {
    routeStore.removeWaypoint(waypointId);

    const existingMarker = markersMap.get(waypointId);
    if (existingMarker) {
      existingMarker.remove();
      markersMap.delete(waypointId);
    }
    routeStore.calculateRoute();
  }
}

/* ------------------------------------------------------------------
   #3 onMapMouseMove => show ephemeral near route if not dragging
------------------------------------------------------------------ */
function onMapMouseMove(e: MapMouseEvent) {
  // Exit early if we're dragging any marker or map isn't initialized
  if (isDraggingAnyMarker || !mapInstance.value || !ephemeralMarker) {
    hideEphemeralMarker();
    return;
  }

  // Exit early if we don't have start, end, or route data
  const hasStart = routeStore.getWaypointById("start");
  const hasEnd = routeStore.getWaypointById("end");
  if (!hasStart || !hasEnd || !routeStore.routeData) {
    hideEphemeralMarker();
    return;
  }

  // If ephemeral is committed, don't change its position
  if (ephemeralIsCommitted) {
    return;
  }

  // Try to snap to route
  const snapped = snapToRoute(e.lngLat.lng, e.lngLat.lat);
  if (!snapped) {
    hideEphemeralMarker();
    return;
  }

  // Only show if we're close enough to the route (30 meters)
  const DIST_ROUTE = 5;
  if (snapped.distMeters > DIST_ROUTE) {
    hideEphemeralMarker();
    return;
  }

  // Don't show if we're too close to an existing waypoint (10 meters)
  const DIST_EXISTING = 10;
  if (isTooCloseToExisting(snapped.coord, DIST_EXISTING)) {
    hideEphemeralMarker();
    return;
  }

  // Update and show the ephemeral marker
  ephemeralMarker.setLngLat(snapped.coord);
  showEphemeralMarker();
}

/* ------------------------------------------------------------------
   #4 onMapMouseDown => if user directly clicks ephemeral but doesn't drag
------------------------------------------------------------------ */
function onMapMouseDown(e: MapMouseEvent) {
  if (
    !mapInstance.value ||
    !ephemeralMarker ||
    !ephemeralIsVisible ||
    ephemeralIsCommitted
  ) {
    return;
  }

  // Get coordinates of the ephemeral marker
  const ephemeralLL = ephemeralMarker.getLngLat();
  if (!ephemeralLL) return;

  // Calculate screen distance between click and marker
  const ephemeralPt = mapInstance.value.project(ephemeralLL);
  const dx = ephemeralPt.x - e.point.x;
  const dy = ephemeralPt.y - e.point.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // If the click is on the marker, commit it
  if (dist <= 10) {
    ephemeralIsCommitted = true;

    // Create a new waypoint ID
    const newId = `wp-${Date.now()}`;

    // Safely set the element ID
    const element = ephemeralMarker.getElement();
    if (element) {
      element.id = newId;
    }

    // Add the waypoint to the store
    routeStore.addWaypoint({
      id: newId,
      coord: [ephemeralLL.lng, ephemeralLL.lat],
    });

    // Prevent other click handlers
    e.originalEvent.preventDefault();
    e.originalEvent.stopPropagation();
  }
}

/* ------------------------------------------------------------------
   #5 onMapMouseUp => if ephemeral is committed & not dragged => finalize
------------------------------------------------------------------ */
function onMapMouseUp(e: MapMouseEvent) {
  // If the ephemeral marker was committed but not dragged, finalize it
  if (ephemeralIsCommitted && !isDraggingEphemeral) {
    // Calculate the route with the new waypoint
    routeStore.calculateRoute();

    // Reset the ephemeral marker state
    ephemeralIsVisible = false;
    ephemeralIsCommitted = false;
  }
}

/* ------------------------------------------------------------------
   Ephemeral marker drag logic
------------------------------------------------------------------ */
function onEphemeralDragStart(
  e: maplibregl.MapMouseEvent & { target: Marker }
) {
  isDraggingEphemeral = true;
  isDraggingAnyMarker = true;

  if (!ephemeralMarker) return;

  // Get coordinates directly from the event target
  const ephemeralLL = e.target.getLngLat();
  if (!ephemeralLL) {
    console.warn("Ephemeral marker has no coordinate at dragstart.");
    return;
  }

  // If not committed yet, commit now
  if (!ephemeralIsCommitted) {
    ephemeralIsCommitted = true;
    const newId = `wp-${Date.now()}`;

    // Safely set the ID on the DOM element
    const element = ephemeralMarker.getElement();
    if (element) {
      element.id = newId;
    }

    // Add the waypoint to the store
    routeStore.addWaypoint({
      id: newId,
      coord: [ephemeralLL.lng, ephemeralLL.lat],
    });
  }
}

function onEphemeralDrag(e: maplibregl.MapMouseEvent & { target: Marker }) {
  if (!ephemeralMarker || !ephemeralIsCommitted) return;

  // Get the element to find the ID
  const element = ephemeralMarker.getElement();
  if (!element || !element.id) return;

  const waypointId = element.id;
  const newCoord = e.target.getLngLat();

  // Update the waypoint in the store
  routeStore.updateWaypoint(waypointId, [newCoord.lng, newCoord.lat]);
}

function onEphemeralDragEnd(e: maplibregl.MapMouseEvent & { target: Marker }) {
  // Reset dragging state
  isDraggingEphemeral = false;
  isDraggingAnyMarker = false;

  // If we committed the marker, recalculate the route
  if (ephemeralIsCommitted) {
    routeStore.calculateRoute();
  }

  // Reset the ephemeral marker
  hideEphemeralMarker();
  ephemeralIsCommitted = false;
}

/* ------------------------------------------------------------------
   snapToRoute => nearest point on route
------------------------------------------------------------------ */
function snapToRoute(
  lng: number,
  lat: number
): { coord: [number, number]; distMeters: number } | null {
  const route = routeStore.routeData?.features?.[0];
  if (!route || route.geometry.type !== "LineString") return null;

  const coords = route.geometry.coordinates as [number, number][];
  if (coords.length < 2) return null;

  const line = lineString(coords);
  const pt = point([lng, lat]);
  const snapped = nearestPointOnLine(line, pt);

  const distMeters = (snapped.properties?.dist ?? 0) * 1000;
  const c = snapped.geometry.coordinates as [number, number];
  return { coord: c, distMeters };
}

/* ------------------------------------------------------------------
   showEphemeralMarker => add ephemeral to map if not visible
------------------------------------------------------------------ */
function showEphemeralMarker() {
  if (!ephemeralMarker || !mapInstance.value) return;

  if (!ephemeralIsVisible) {
    ephemeralMarker.addTo(mapInstance.value);
    ephemeralIsVisible = true;
  }
}

/* ------------------------------------------------------------------
   hideEphemeralMarker => remove ephemeral if not committed
------------------------------------------------------------------ */
function hideEphemeralMarker() {
  if (!ephemeralMarker) return;

  // Only remove from map if not committed
  if (ephemeralIsVisible && !ephemeralIsCommitted) {
    ephemeralMarker.remove();
    ephemeralIsVisible = false;
  }
}

/* ------------------------------------------------------------------
   isTooCloseToExisting => prevents new marker if near an existing
------------------------------------------------------------------ */
function isTooCloseToExisting(
  coord: [number, number],
  minMeters: number
): boolean {
  const ephemPt = point(coord);
  for (const wp of routeStore.waypoints) {
    const wpPt = point(wp.coord);
    const distKm = turfDistance(ephemPt, wpPt);
    if (distKm * 1000 < minMeters) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------
   drawRouteLine => draws route
------------------------------------------------------------------ */
function drawRouteLine(routeData: GeoJSON.FeatureCollection) {
  if (!mapInstance.value) return;
  const map = mapInstance.value;

  if (map.getLayer(ROUTE_LAYER_ID)) map.removeLayer(ROUTE_LAYER_ID);
  if (map.getSource(ROUTE_SOURCE_ID)) map.removeSource(ROUTE_SOURCE_ID);

  map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: routeData });
  map.addLayer({
    id: ROUTE_LAYER_ID,
    type: "line",
    source: ROUTE_SOURCE_ID,
    paint: {
      "line-color": "#FF5722",
      "line-width": 4,
      "line-opacity": 0.8,
    },
  });

  const bbox = routeData.bbox;
  if (bbox && bbox.length === 4) {
    map.fitBounds(
      [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ],
      { padding: 40, duration: 600 }
    );
  }
}

/* ------------------------------------------------------------------
   setupMarkers => create or update store-based markers
------------------------------------------------------------------ */
function setupMarkers() {
  if (!mapInstance.value) return;

  const storeIds = routeStore.waypoints.map((wp) => wp.id);
  for (const id of markersMap.keys()) {
    if (!storeIds.includes(id)) {
      markersMap.get(id)?.remove();
      markersMap.delete(id);
    }
  }

  routeStore.waypoints.forEach((wp) => {
    if (markersMap.has(wp.id)) {
      markersMap.get(wp.id)?.setLngLat(wp.coord);
      return;
    }
    const newMarker = new maplibregl.Marker({
      draggable: true,
      color: getMarkerColor(wp.id),
    })
      .setLngLat(wp.coord)
      .addTo(mapInstance.value!);

    // If user drags any store-based marker => ephemeral is hidden
    newMarker.on("dragstart", () => {
      isDraggingAnyMarker = true;
      hideEphemeralMarker();
    });
    newMarker.on("drag", (ev) => {
      const c = ev.target.getLngLat();
      routeStore.updateWaypoint(wp.id, [c.lng, c.lat]);
    });
    newMarker.on("dragend", () => {
      isDraggingAnyMarker = false;
      routeStore.calculateRoute();
    });

    markersMap.set(wp.id, newMarker);
  });
}

/* ------------------------------------------------------------------
   watch routeData => redraw route + snap store markers
------------------------------------------------------------------ */
watch(
  () => routeStore.routeData,
  (newRoute) => {
    if (!newRoute) return;
    drawRouteLine(newRoute);
    snapAllMarkersToRoute(newRoute);
  }
);

/* ------------------------------------------------------------------
   snapAllMarkersToRoute => snap store-based markers
------------------------------------------------------------------ */
function snapAllMarkersToRoute(routeData: GeoJSON.FeatureCollection) {
  const feature = routeData.features?.[0];
  if (!feature || feature.geometry.type !== "LineString") return;

  const coords = feature.geometry.coordinates as [number, number][];
  if (coords.length < 2) return;

  const line = lineString(coords);
  routeStore.waypoints.forEach((wp) => {
    const snapped = nearestPointOnLine(line, point(wp.coord));
    const c = snapped.geometry.coordinates as [number, number];
    routeStore.updateWaypoint(wp.id, c);
    markersMap.get(wp.id)?.setLngLat(c);
  });
}

/* ------------------------------------------------------------------
   watch waypoints => re-setup markers
------------------------------------------------------------------ */
watch(
  () => routeStore.waypoints,
  () => {
    setupMarkers();
  },
  { deep: true }
);

/* ------------------------------------------------------------------
   findWaypointNearClick => see if user right-clicked near a marker
------------------------------------------------------------------ */
function findWaypointNearClick(
  p: maplibregl.Point,
  tol: number
): string | null {
  if (!mapInstance.value) return null;
  for (const wp of routeStore.waypoints) {
    const mp = mapInstance.value.project(wp.coord);
    const dx = mp.x - p.x;
    const dy = mp.y - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= tol) {
      return wp.id;
    }
  }
  return null;
}

/* ------------------------------------------------------------------
   getFeaturesNearPoint => route features near bounding box
------------------------------------------------------------------ */
function getFeaturesNearPoint(
  p: maplibregl.Point,
  buffer: number,
  layers: string[]
) {
  if (!mapInstance.value) return [];
  const bbox: [PointLike, PointLike] = [
    [p.x - buffer, p.y - buffer],
    [p.x + buffer, p.y + buffer],
  ];
  return mapInstance.value.queryRenderedFeatures(bbox, { layers }) || [];
}

/* ------------------------------------------------------------------
   getMarkerColor => start=green, end=red, intermediate=blue
------------------------------------------------------------------ */
function getMarkerColor(id: string): string {
  if (id === "start") return "green";
  if (id === "end") return "red";
  return "#00afff";
}
</script>

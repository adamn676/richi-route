<script setup lang="ts">
import { onMounted, ref, shallowRef, watch } from "vue";
import { getMapTilerStyleUrl } from "@/services";

import maplibregl, {
  Map as MaplibreMap,
  Marker,
  MapMouseEvent,
  type PointLike,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import {
  DIST_ROUTE,
  DIST_EXISTING,
  ROUTE_LAYER_ID,
  ROUTE_SOURCE_ID,
} from "@/config/map.config";

import {
  lineString,
  point,
  nearestPointOnLine,
  distance as turfDistance,
} from "@turf/turf";

import { useRouteStore } from "@/stores";
const routeStore = useRouteStore();

// For store-based markers
const markersMap = new Map<string, Marker>();

// Single ephemeral marker
let ephemeralMarker: Marker | null = null;
let ephemeralVisible = false;
let ephemeralCommitted = false;

// Track ephemeral dragging & any dragging
let isDraggingEphemeral = false;
let isDraggingAnyMarker = false;

const mapContainer = ref<HTMLDivElement | null>(null);
const mapInstance = shallowRef<MaplibreMap | null>(null);

onMounted(() => {
  if (!mapContainer.value) return;

  mapInstance.value = new maplibregl.Map({
    container: mapContainer.value,
    style: getMapTilerStyleUrl("streets"),
    center: [15.4417, 47.0679],
    zoom: 15,
  });

  mapInstance.value.addControl(new maplibregl.NavigationControl(), "top-right");

  // Create ephemeral marker once
  ephemeralMarker = new maplibregl.Marker({
    draggable: true,
    color: "#0d6efd",
    scale: 0.8,
  });

  // Ephemeral marker events
  ephemeralMarker.on("dragstart", onEphemeralDragStart);
  ephemeralMarker.on("drag", onEphemeralDrag);
  ephemeralMarker.on("dragend", onEphemeralDragEnd);

  ephemeralVisible = false;
  ephemeralCommitted = false;

  mapInstance.value.on("load", () => {
    setupMarkers();
    if (routeStore.routeData) {
      drawRouteLine(routeStore.routeData);
    }
  });

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
    // Final step: route now that we have start & end
    routeStore.calculateRoute();
    return;
  }

  // If we have both start & end => check if user clicked route
  const routeFeatures = getFeaturesNearPoint(e.point, 15, [ROUTE_LAYER_ID]);
  if (routeFeatures.length === 0) {
    // user clicked off-route => move end
    routeStore.updateWaypoint("end", [lng, lat]);
    setupMarkers();
    // route only once final pos is set
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
  // If we’re dragging or the map isn't ready, skip
  if (isDraggingAnyMarker || !mapInstance.value || !ephemeralMarker) {
    hideEphemeralMarker();
    return;
  }

  // If no start/end or no route data => skip ephemeral
  const hasStart = routeStore.getWaypointById("start");
  const hasEnd = routeStore.getWaypointById("end");
  if (!hasStart || !hasEnd || !routeStore.routeData) {
    hideEphemeralMarker();
    return;
  }

  // If ephemeral is already committed => skip
  if (ephemeralCommitted) {
    return;
  }

  // Snap to route
  const snapped = snapToRoute(e.lngLat.lng, e.lngLat.lat);
  if (!snapped) {
    hideEphemeralMarker();
    return;
  }

  // If too far from route, hide ephemeral
  if (snapped.distMeters > DIST_ROUTE) {
    hideEphemeralMarker();
    return;
  }

  // If too close to an existing waypoint
  if (isTooCloseToExisting(snapped.coord, DIST_EXISTING)) {
    hideEphemeralMarker();
    return;
  }

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
    !ephemeralVisible ||
    ephemeralCommitted
  ) {
    return;
  }

  const ephemeralLL = ephemeralMarker.getLngLat();
  if (!ephemeralLL) return;

  const ephemeralPt = mapInstance.value.project(ephemeralLL);
  const dx = ephemeralPt.x - e.point.x;
  const dy = ephemeralPt.y - e.point.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // If user clicked on ephemeral marker => commit
  if (dist <= 10) {
    ephemeralCommitted = true;

    const newId = `wp-${Date.now()}`;
    const element = ephemeralMarker.getElement();
    if (element) element.id = newId;

    // Add waypoint
    routeStore.addWaypoint({
      id: newId,
      coord: [ephemeralLL.lng, ephemeralLL.lat],
    });

    // Stop map’s default click
    e.originalEvent.preventDefault();
    e.originalEvent.stopPropagation();
  }
}

/* ------------------------------------------------------------------
   #5 onMapMouseUp => if ephemeral committed & not dragged => finalize
------------------------------------------------------------------ */
function onMapMouseUp(e: MapMouseEvent) {
  // If ephemeral was just clicked (committed) but not actually dragged
  if (ephemeralCommitted && !isDraggingEphemeral) {
    // final route calc
    routeStore.calculateRoute();
    ephemeralVisible = false;
    ephemeralCommitted = false;
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

  const ephemeralLL = e.target.getLngLat();
  if (!ephemeralLL) {
    console.warn("Ephemeral marker has no coordinate at dragstart.");
    return;
  }

  // If we never committed ephemeral, do so now
  if (!ephemeralCommitted) {
    ephemeralCommitted = true;
    const newId = `wp-${Date.now()}`;
    const element = ephemeralMarker.getElement();
    if (element) element.id = newId;

    routeStore.addWaypoint({
      id: newId,
      coord: [ephemeralLL.lng, ephemeralLL.lat],
    });
  }
}

function onEphemeralDrag(e: maplibregl.MapMouseEvent & { target: Marker }) {
  if (!ephemeralMarker || !ephemeralCommitted) return;

  const element = ephemeralMarker.getElement();
  if (!element || !element.id) return;
  const waypointId = element.id;

  const newCoord = e.target.getLngLat();
  routeStore.updateWaypoint(waypointId, [newCoord.lng, newCoord.lat]);
}

function onEphemeralDragEnd(e: maplibregl.MapMouseEvent & { target: Marker }) {
  // Drag end => finalize route
  isDraggingEphemeral = false;
  isDraggingAnyMarker = false;

  if (ephemeralCommitted) {
    routeStore.calculateRoute();
  }

  hideEphemeralMarker();
  ephemeralCommitted = false;
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

  if (!ephemeralVisible) {
    ephemeralMarker.addTo(mapInstance.value);
    ephemeralVisible = true;
  }
}

/* ------------------------------------------------------------------
   hideEphemeralMarker => remove ephemeral if not committed
------------------------------------------------------------------ */
function hideEphemeralMarker() {
  if (!ephemeralMarker) return;

  if (ephemeralVisible && !ephemeralCommitted) {
    ephemeralMarker.remove();
    ephemeralVisible = false;
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
   drawRouteLine => draws route line from routeData
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
      {
        padding: 40,
        duration: 600,
      }
    );
  }
}

/* ------------------------------------------------------------------
   setupMarkers => create or update store-based markers
------------------------------------------------------------------ */
function setupMarkers() {
  if (!mapInstance.value) return;

  const storeIds = routeStore.waypoints.map((wp) => wp.id);
  // remove stale markers
  for (const id of markersMap.keys()) {
    if (!storeIds.includes(id)) {
      markersMap.get(id)?.remove();
      markersMap.delete(id);
    }
  }

  // add or update new markers
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

    // If user drags a store-based marker => ephemeral is hidden
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
      // final route call
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
  return "#00afff"; // default for in-between markers
}
</script>

<template>
  <div class="relative w-full h-full">
    <div ref="mapContainer" class="w-full h-full"></div>
  </div>
</template>

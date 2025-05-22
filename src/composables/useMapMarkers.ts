// src/composables/useMapMarkers.ts
import { type Ref, unref } from 'vue';
import { createApp } from 'vue';
import maplibregl, { type Map as MaplibreMap, type Marker } from 'maplibre-gl';
import CustomMarker from '@/components/map/CustomMarker.vue';
import type { Coord } from '@/services/maptiler.service';
import { useRouteStore, type ShapePoint as StoreShapePoint, type Waypoint as StoreWaypoint } from '@/stores/route.store';
import { getRadiusForZoom } from '@/utils/mapHelpers';
import { bearing as turfBearing, point as turfPoint } from '@turf/turf'; // Using main @turf/turf package
import type { BearingValue } from '@/services/route.service';

// createCustomMarkerElement function remains the same...
function createCustomMarkerElement(type: 'waypoint' | 'shaping' | 'temp-shaping', icon?: string, number?: number, isDraggablePreview?: boolean) {
  const el = document.createElement('div');
  let markerIcon = icon;
  let markerSize = type === 'waypoint' ? 36 : 28;
  let markerIconSize = type === 'waypoint' ? 22 : 16;
  let iconColor = type === 'shaping' || type === 'temp-shaping' ? 'text-indigo-900' : 'text-white';
  let background = type === 'waypoint' ? 'bg-indigo-500' : 'bg-indigo-300';
  let zIndex = type === 'waypoint' ? 10 : 5;

  if (type === 'shaping') {
    markerIcon = icon || 'circle';
    markerSize = 16;
    markerIconSize = 8;
    background = 'bg-purple-500';
    iconColor = 'text-white';
    zIndex = 8;
  } else if (type === 'temp-shaping') {
    markerIcon = icon || 'drag_handle';
    markerSize = 24;
    markerIconSize = 16;
    background = 'bg-pink-500';
    zIndex = 15;
  }

  const app = createApp(CustomMarker, {
    type,
    icon: markerIcon,
    size: markerSize,
    iconSize: markerIconSize,
    iconColor: iconColor,
    background: background,
    number,
    isDraggablePreview: isDraggablePreview || false,
  });
  app.mount(el);
  el.style.zIndex = String(zIndex);
  return el;
}

export function useMapMarkers(mapRef: Ref<MaplibreMap | null>) {
  const routeStore = useRouteStore();
  const waypointMarkersMap = new Map<string, maplibregl.Marker>();
  const shapingMarkersMap = new Map<string, maplibregl.Marker>();

  const BEARING_CONSTRAINT_RANGE = 45; // Tolerance for bearing in degrees

  const clearAllMarkers = () => {
    waypointMarkersMap.forEach((marker) => marker.remove());
    waypointMarkersMap.clear();
    shapingMarkersMap.forEach((marker) => marker.remove());
    shapingMarkersMap.clear();
    console.log('[useMapMarkers] All markers cleared.');
  };

  const createWaypointMarkers = (waypoints: StoreWaypoint[], options: { draggable?: boolean } = {}) => {
    const map = unref(mapRef);
    if (!map) return;

    const newWaypointIds = new Set(waypoints.map((wp) => wp.id));
    waypointMarkersMap.forEach((marker, id) => {
      if (!newWaypointIds.has(id)) {
        marker.remove();
        waypointMarkersMap.delete(id);
      }
    });

    waypoints.forEach((waypoint, index) => {
      const existingMarker = waypointMarkersMap.get(waypoint.id);
      if (existingMarker) {
        existingMarker.setLngLat(waypoint.coords);
        const el = existingMarker.getElement();
        if (el?.querySelector('.marker-number')) {
          (el.querySelector('.marker-number') as HTMLElement).innerText = (index + 1).toString();
        }
      } else {
        const el = createCustomMarkerElement('waypoint', 'location_on', index + 1);
        const marker = new maplibregl.Marker({
          element: el,
          draggable: options.draggable ?? true,
        })
          .setLngLat(waypoint.coords)
          .addTo(map);
        waypointMarkersMap.set(waypoint.id, marker);

        if (options.draggable) {
          marker.on('dragend', () => {
            const newCoords = marker.getLngLat();
            console.log(`[useMapMarkers] Waypoint ${waypoint.id} dragged to:`, newCoords);
            routeStore.updateWaypointCoord(waypoint.id, [newCoords.lng, newCoords.lat]);
          });
        }
      }
    });
  };

  const createShapingMarkers = (shapingPointsData: StoreShapePoint[], options: { draggable?: boolean } = {}) => {
    const map = unref(mapRef);
    if (!map) return;

    const newShapingPointIds = new Set(shapingPointsData.map((sp) => sp.id));
    shapingMarkersMap.forEach((marker, id) => {
      if (!newShapingPointIds.has(id)) {
        marker.remove();
        shapingMarkersMap.delete(id);
      }
    });

    shapingPointsData.forEach((spData) => {
      const existingMarker = shapingMarkersMap.get(spData.id);
      if (existingMarker) {
        existingMarker.setLngLat(spData.coord);
      } else {
        const el = createCustomMarkerElement('shaping');
        const marker = new maplibregl.Marker({
          element: el,
          draggable: options.draggable ?? true,
        })
          .setLngLat(spData.coord)
          .addTo(map);
        shapingMarkersMap.set(spData.id, marker);

        if (options.draggable) {
          // Logic for mousedown (dragstart) to calculate initial bearings
          marker.on('dragstart', () => {
            console.log(`[useMapMarkers] Shaping point ${spData.id} dragstart.`);
            let calculatedBearing: BearingValue = null;
            const currentRoute = routeStore.route;

            if (currentRoute && currentRoute.features.length > 0 && currentRoute.features[0].geometry.type === 'LineString') {
              const routeCoords = currentRoute.features[0].geometry.coordinates as Coord[];
              // Find the index of the shaping point's current coordinate in the route
              // This is an approximation; SP coords might not be exactly in routeCoords
              // A more robust way is to find the *closest point on the linestring* and its neighbors
              // For now, let's try direct matching, assuming SP coords are on the line after shaping

              let spIndexInRoute = -1;
              for (let i = 0; i < routeCoords.length; i++) {
                if (routeCoords[i][0] === spData.coord[0] && routeCoords[i][1] === spData.coord[1]) {
                  spIndexInRoute = i;
                  break;
                }
              }

              // If not found by exact match, find the closest point (more robust)
              // This part can be complex and computationally intensive if not careful
              // For simplicity, we proceed if exact match found, otherwise no bearing.
              // A production version would need a robust "find point on line" and its neighbors.

              if (spIndexInRoute !== -1) {
                const pSp = turfPoint(spData.coord);
                let bearingIn: number | null = null;
                let bearingOut: number | null = null;

                if (spIndexInRoute > 0) {
                  const pPrev = turfPoint(routeCoords[spIndexInRoute - 1]);
                  bearingIn = turfBearing(pPrev, pSp);
                }
                if (spIndexInRoute < routeCoords.length - 1) {
                  const pNext = turfPoint(routeCoords[spIndexInRoute + 1]);
                  bearingOut = turfBearing(pSp, pNext);
                }

                if (bearingIn !== null && bearingOut !== null) {
                  calculatedBearing = [
                    [bearingIn, BEARING_CONSTRAINT_RANGE],
                    [bearingOut, BEARING_CONSTRAINT_RANGE],
                  ];
                } else if (bearingOut !== null) {
                  // e.g. if SP is first point after start WP
                  calculatedBearing = [bearingOut, BEARING_CONSTRAINT_RANGE]; // Apply as departure/general
                } else if (bearingIn !== null) {
                  // e.g. if SP is last point before end WP
                  calculatedBearing = [bearingIn, BEARING_CONSTRAINT_RANGE]; // Apply as arrival/general
                }
                console.log(`[useMapMarkers] Calculated bearing for ${spData.id}:`, calculatedBearing);
              } else {
                console.warn(
                  `[useMapMarkers] Could not find exact SP coord in route for bearing calculation for ${spData.id}. No bearing constraint will be applied for this drag.`
                );
              }
            }
            routeStore.setDraggedShapingPointBearing(calculatedBearing ? { id: spData.id, bearing: calculatedBearing } : null);
          });

          marker.on('dragend', () => {
            const newCoords = marker.getLngLat();
            const currentMapInstance = unref(mapRef);
            let recalculatedRadius = spData.radius;

            if (currentMapInstance) {
              const zoom = currentMapInstance.getZoom();
              recalculatedRadius = getRadiusForZoom(zoom);
              console.log(
                `[useMapMarkers] Shaping point ${spData.id} dragged. Coords: ${JSON.stringify(newCoords)}, Radius: ${recalculatedRadius}m (Zoom: ${zoom.toFixed(
                  2
                )})`
              );
            } else {
              console.warn(
                `[useMapMarkers] Shaping point ${spData.id} dragged. Coords: ${JSON.stringify(
                  newCoords
                )}. Map not available for zoom, original radius: ${recalculatedRadius}`
              );
            }

            // Update store; recalc will use draggedShapingPointBearing from store
            routeStore.updateShapingPointCoord(spData.id, [newCoords.lng, newCoords.lat], recalculatedRadius);
            // Clear the bearing state after the drag operation is processed (recalc is async)
            // It might be better for recalc to clear it once used. For now, clear immediately.
            // Or, more robustly, the watcher that triggers recalc could clear it after recalc promise resolves.
            // Let's clear it here for now. The store action `applyShaping` will use it and then it's stale.
            routeStore.clearDraggedShapingPointBearing();
          });
        }
      }
    });
  };

  const createTempMarker = (coord: Coord, type: 'temp-shaping' = 'temp-shaping'): Marker | null => {
    const map = unref(mapRef);
    if (!map) return null;
    const el = createCustomMarkerElement(type, undefined, undefined, true);
    const marker = new maplibregl.Marker({
      element: el,
      draggable: false,
    })
      .setLngLat(coord)
      .addTo(map);
    return marker;
  };

  return {
    clearAllMarkers,
    createWaypointMarkers,
    createShapingMarkers,
    createTempMarker,
  };
}

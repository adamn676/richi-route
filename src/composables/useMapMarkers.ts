// src/composables/useMapMarkers.ts
import { type Ref, unref } from 'vue';
import { createApp } from 'vue';
import maplibregl, { type Map as MaplibreMap, type Marker } from 'maplibre-gl';
import CustomMarker from '@/components/map/CustomMarker.vue';
import type { Coord } from '@/services/maptiler.service';
import { useRouteStore, type ShapePoint as StoreShapePoint, type Waypoint as StoreWaypoint } from '@/stores/route.store';
import { getRadiusForZoom } from '@/utils/mapHelpers';
import { bearing as turfBearing, point as turfPoint, nearestPointOnLine } from '@turf/turf';
import type { Feature, Point as TurfGeoJSONPoint, LineString } from 'geojson'; // Ensure LineString is imported
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
          marker.on('dragstart', () => {
            console.log(`[useMapMarkers] Shaping point ${spData.id} dragstart.`);
            let calculatedBearingConstraint: BearingValue = null;
            const currentRoute = routeStore.route;

            if (currentRoute && currentRoute.features.length > 0 && currentRoute.features[0].geometry.type === 'LineString') {
              // Use the LineString type from 'geojson' for the cast
              const routeLineString = currentRoute.features[0].geometry as LineString;
              const routeCoords = routeLineString.coordinates as Coord[]; // Assuming Coord is [number, number]
              const draggedSpTurfPoint = turfPoint(spData.coord);

              const closestPointFeature = nearestPointOnLine(routeLineString, draggedSpTurfPoint, { units: 'meters' }) as Feature<
                TurfGeoJSONPoint,
                { index: number; dist: number; location: number }
              >;

              if (closestPointFeature && typeof closestPointFeature.properties.index === 'number') {
                const segmentIndex = closestPointFeature.properties.index;
                const pointBeforeSegment = routeCoords[segmentIndex];
                const pointAfterSegment = routeCoords[segmentIndex + 1];

                if (pointBeforeSegment && pointAfterSegment) {
                  const segmentBearing = turfBearing(turfPoint(pointBeforeSegment), turfPoint(pointAfterSegment));
                  calculatedBearingConstraint = [segmentBearing, BEARING_CONSTRAINT_RANGE];
                  console.log(
                    `[useMapMarkers] SP ${spData.id} snapped to segment ${segmentIndex} (between ${JSON.stringify(pointBeforeSegment)} and ${JSON.stringify(
                      pointAfterSegment
                    )}) with segment bearing ${segmentBearing.toFixed(2)}. Calculated bearing constraint:`,
                    JSON.stringify(calculatedBearingConstraint)
                  );
                } else {
                  console.warn(
                    `[useMapMarkers] Could not find valid segment points for bearing calculation for SP ${spData.id} on segment index ${segmentIndex}.`
                  );
                }
              } else {
                console.warn(
                  `[useMapMarkers] Could not snap SP ${spData.id} to route for bearing calculation. 'closestPointFeature.properties.index' is undefined.`
                );
              }
            } else {
              console.warn(`[useMapMarkers] No valid route linestring found for bearing calculation for SP ${spData.id}.`);
            }
            routeStore.setDraggedShapingPointBearing(calculatedBearingConstraint ? { id: spData.id, bearing: calculatedBearingConstraint } : null);
          });

          marker.on('dragend', () => {
            const newCoords = marker.getLngLat();
            const currentMapInstance = unref(mapRef);
            let recalculatedRadius = spData.radius;

            if (currentMapInstance) {
              const zoom = currentMapInstance.getZoom();
              recalculatedRadius = getRadiusForZoom(zoom);
              console.log(
                `[useMapMarkers] Shaping point ${spData.id} dragged. Coords: ${JSON.stringify(
                  newCoords
                )}, New Radius: ${recalculatedRadius}m (Zoom: ${zoom.toFixed(2)})`
              );
            } else {
              console.warn(
                `[useMapMarkers] Shaping point ${spData.id} dragged. Coords: ${JSON.stringify(
                  newCoords
                )}. Map not available for zoom, using original radius: ${recalculatedRadius}`
              );
            }
            routeStore.updateShapingPointCoord(spData.id, [newCoords.lng, newCoords.lat], recalculatedRadius);
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

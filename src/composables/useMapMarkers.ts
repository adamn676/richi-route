// // src/composables/useMapMarkers.ts
// import { type Ref } from 'vue';
// import { createApp } from 'vue';
// import maplibregl from 'maplibre-gl';
// import CustomMarker from '@/components/map/CustomMarker.vue';
// import type { Coord } from '@/services/maptiler.service';
// import { useRouteStore } from '@/stores/route.store';

// // Create a custom marker element using Vue component
// function createCustomMarkerElement(type: 'waypoint' | 'shaping', icon?: string, number?: number) {
//   // Create a container div
//   const el = document.createElement('div');

//   // Create a Vue app
//   const app = createApp(CustomMarker, {
//     type,
//     icon: icon || (type === 'waypoint' ? 'location_on' : 'drag_indicator'),
//     size: type === 'waypoint' ? 36 : 28,
//     iconSize: type === 'waypoint' ? 6 : 4,
//     iconColor: type === 'shaping' ? 'text-indigo-900' : 'text-white',
//     number,
//   });

//   // Mount the Vue app to the container
//   app.mount(el);

//   return el;
// }

// export function useMapMarkers(map: Ref<maplibregl.Map | null>) {
//   const waypointMarkers: maplibregl.Marker[] = [];
//   const shapingMarkers: maplibregl.Marker[] = [];
//   const routeStore = useRouteStore();

//   // Clean up all markers
//   const clearMarkers = () => {
//     [...waypointMarkers, ...shapingMarkers].forEach((marker) => marker.remove());
//     waypointMarkers.length = 0;
//     shapingMarkers.length = 0;
//   };

//   // Create waypoint markers
//   const createWaypointMarkers = (waypoints: { id: string; coords: Coord }[], options: { draggable?: boolean } = {}) => {
//     // console.log('createWaypointMarkers - waypoints:', waypoints);
//     // Remove old markers
//     waypointMarkers.forEach((marker) => marker.remove());
//     waypointMarkers.length = 0;

//     // Create new markers
//     waypoints.forEach((waypoint, index) => {
//       // Assuming waypoints now have an 'id'
//       // console.log(`waypoint[${index}] id=${waypoint.id} coords=`, waypoint.coords);
//       if (!map.value) return;

//       const el = createCustomMarkerElement('waypoint', 'location_on', index + 1);

//       const marker = new maplibregl.Marker({
//         element: el,
//         draggable: options.draggable ?? true,
//       })
//         .setLngLat(waypoint.coords)
//         .addTo(map.value);

//       waypointMarkers.push(marker);

//       if (options.draggable) {
//         marker.on('dragend', () => {
//           const newCoords = marker.getLngLat();
//           const waypointId = waypoint.id;

//           if (waypointId) {
//             routeStore.updateWaypointCoord(waypointId, [newCoords.lng, newCoords.lat]);
//           } else {
//             console.error('Waypoint ID not found for dragged marker');
//           }
//         });
//       }
//     });

//     return waypointMarkers;
//   };

//   // Create shaping point markers
//   const createShapingMarkers = (shapingPoints: Coord[], options: { draggable?: boolean } = {}) => {
//     // Remove old markers
//     shapingMarkers.forEach((marker) => marker.remove());
//     shapingMarkers.length = 0;

//     // Create new markers
//     shapingPoints.forEach((coord, _index) => {
//       if (!map.value) return;

//       const el = createCustomMarkerElement('shaping', 'drag_indicator');

//       const marker = new maplibregl.Marker({
//         element: el,
//         draggable: options.draggable ?? true,
//       })
//         .setLngLat(coord)
//         .addTo(map.value);

//       shapingMarkers.push(marker);

//       // Add drag events if needed
//       if (options.draggable) {
//         // Add drag end handler here if needed
//       }
//     });

//     return shapingMarkers;
//   };

//   // Create a temporary marker (for dragging)
//   const createTempMarker = (coord: Coord, type: 'waypoint' | 'shaping' = 'shaping') => {
//     if (!map.value) return null;

//     const el = createCustomMarkerElement(type, type === 'waypoint' ? 'location_on' : 'drag_handle');

//     const marker = new maplibregl.Marker({
//       element: el,
//       draggable: false,
//     })
//       .setLngLat(coord)
//       .addTo(map.value);

//     return marker;
//   };

//   return {
//     waypointMarkers,
//     shapingMarkers,
//     clearMarkers,
//     createWaypointMarkers,
//     createShapingMarkers,
//     createTempMarker,
//   };
// }

// src/composables/useMapMarkers.ts
import { type Ref, unref } from 'vue'; // Added unref
import { createApp } from 'vue';
import maplibregl from 'maplibre-gl';
import CustomMarker from '@/components/map/CustomMarker.vue';
import type { Coord } from '@/services/maptiler.service';
import { useRouteStore, type ShapePoint as StoreShapePoint, type Waypoint as StoreWaypoint } from '@/stores/route.store'; // Import full ShapePoint and Waypoint

// Helper to create custom marker Vue component instance
function createCustomMarkerElement(
  type: 'waypoint' | 'shaping' | 'temp-shaping', // Added 'temp-shaping' for clarity
  icon?: string,
  number?: number,
  isDraggablePreview?: boolean // For temporary shaping marker during drag
) {
  const el = document.createElement('div');
  let markerIcon = icon;
  let markerSize = type === 'waypoint' ? 36 : 28; // Default for shaping/temp
  let markerIconSize = type === 'waypoint' ? 22 : 16; // Default for shaping/temp icons (adjust from 6/4)
  let iconColor = type === 'shaping' || type === 'temp-shaping' ? 'text-indigo-900' : 'text-white';
  let background = type === 'waypoint' ? 'bg-indigo-500' : 'bg-indigo-300';
  let zIndex = type === 'waypoint' ? 10 : 5; // Waypoints above shaping points

  if (type === 'shaping') {
    // Persistent shaping point
    markerIcon = icon || 'circle'; // Small circle for persistent shaping point
    markerSize = 16; // Smaller
    markerIconSize = 8; // Smaller icon within, if 'circle' is an outline
    background = 'bg-purple-500'; // Different color to distinguish
    iconColor = 'text-white';
    zIndex = 8; // Above route, below waypoints
  } else if (type === 'temp-shaping') {
    // Temporary marker when dragging a segment
    markerIcon = icon || 'drag_handle'; // From prompt
    markerSize = 24;
    markerIconSize = 16;
    background = 'bg-pink-500'; // Different color for temp drag
    zIndex = 15; // Highest
  }

  const app = createApp(CustomMarker, {
    type,
    icon: markerIcon,
    size: markerSize,
    iconSize: markerIconSize,
    iconColor: iconColor,
    background: background, // Pass background to CustomMarker if it accepts it
    number,
    isDraggablePreview: isDraggablePreview || false,
  });
  app.mount(el);
  // Apply z-index directly to the marker element if CustomMarker doesn't handle it
  el.style.zIndex = String(zIndex);
  return el;
}

export function useMapMarkers(mapRef: Ref<maplibregl.Map | null>) {
  // map changed to mapRef for clarity
  const routeStore = useRouteStore();
  // Keep separate arrays for different marker types for easier management
  const waypointMarkersMap = new Map<string, maplibregl.Marker>(); // Use Map for ID-based lookup
  const shapingMarkersMap = new Map<string, maplibregl.Marker>(); // Use Map for ID-based lookup

  const clearAllMarkers = () => {
    waypointMarkersMap.forEach((marker) => marker.remove());
    waypointMarkersMap.clear();
    shapingMarkersMap.forEach((marker) => marker.remove());
    shapingMarkersMap.clear();
  };

  const clearWaypointMarkers = () => {
    waypointMarkersMap.forEach((marker) => marker.remove());
    waypointMarkersMap.clear();
  };

  const clearShapingMarkers = () => {
    shapingMarkersMap.forEach((marker) => marker.remove());
    shapingMarkersMap.clear();
  };

  // Waypoint markers (assuming StoreWaypoint has 'id' and 'coords')
  const createWaypointMarkers = (
    waypoints: StoreWaypoint[], // Expect array of full Waypoint objects
    options: { draggable?: boolean } = {}
  ) => {
    const map = unref(mapRef); // Get the map instance
    if (!map) return;

    const newWaypointIds = new Set(waypoints.map((wp) => wp.id));
    // Remove markers for waypoints that no longer exist
    waypointMarkersMap.forEach((marker, id) => {
      if (!newWaypointIds.has(id)) {
        marker.remove();
        waypointMarkersMap.delete(id);
      }
    });

    waypoints.forEach((waypoint, index) => {
      if (waypointMarkersMap.has(waypoint.id)) {
        // Update existing marker position
        const marker = waypointMarkersMap.get(waypoint.id);
        marker?.setLngLat(waypoint.coords);
      } else {
        // Create new marker
        const el = createCustomMarkerElement('waypoint', 'location_on', index + 1);
        const marker = new maplibregl.Marker({
          element: el,
          draggable: options.draggable ?? true,
          // offset: [0, -markerSize / 2] // Adjust offset if needed so pin points to coord
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

  // Shaping point markers
  const createShapingMarkers = (
    shapingPointsData: StoreShapePoint[], // Expect array of full ShapePoint objects
    options: { draggable?: boolean } = {}
  ) => {
    const map = unref(mapRef); // Get the map instance
    if (!map) return;

    const newShapingPointIds = new Set(shapingPointsData.map((sp) => sp.id));
    // Remove markers for shaping points that no longer exist
    shapingMarkersMap.forEach((marker, id) => {
      if (!newShapingPointIds.has(id)) {
        marker.remove();
        shapingMarkersMap.delete(id);
      }
    });

    shapingPointsData.forEach((spData) => {
      if (shapingMarkersMap.has(spData.id)) {
        // Update existing
        const marker = shapingMarkersMap.get(spData.id);
        marker?.setLngLat(spData.coord);
      } else {
        // Create new
        const el = createCustomMarkerElement('shaping'); // Uses 'circle' by default from updated function
        const marker = new maplibregl.Marker({
          element: el,
          draggable: options.draggable ?? true, // Make them draggable
        })
          .setLngLat(spData.coord)
          .addTo(map);

        shapingMarkersMap.set(spData.id, marker);

        if (options.draggable) {
          marker.on('dragend', () => {
            const newCoords = marker.getLngLat();
            console.log(`[useMapMarkers] Shaping point ${spData.id} dragged to:`, newCoords);
            routeStore.updateShapingPointCoord(spData.id, [newCoords.lng, newCoords.lat]);
          });
        }
      }
    });
  };

  // Temporary marker for dragging a new shaping point (from useRouteDragging)
  const createTempMarker = (coord: Coord, type: 'temp-shaping' = 'temp-shaping') => {
    const map = unref(mapRef);
    if (!map) return null;
    // Use 'temp-shaping' type for specific styling
    const el = createCustomMarkerElement(type, undefined, undefined, true);
    const marker = new maplibregl.Marker({
      element: el,
      draggable: false, // This marker itself is not dragged; it follows mouse
    })
      .setLngLat(coord)
      .addTo(map);
    return marker;
  };

  return {
    // Expose specific clear functions if needed, or just a global clear
    clearAllMarkers,
    clearWaypointMarkers,
    clearShapingMarkers,
    createWaypointMarkers,
    createShapingMarkers,
    createTempMarker,
  };
}

// src/composables/useDebugMapLayers.ts
import { watch, type Ref } from 'vue';
import maplibregl, { type Map as MaplibreMap } from 'maplibre-gl';
import * as turf from '@turf/turf';
import { useDebugStore, type DebugRadiusVisualization, type DebugBearingVisualization } from '@/stores/debug.store'; // Assuming you create this

const RADIUS_SOURCE_ID = 'debug-radius-source';
const RADIUS_LAYER_ID = 'debug-radius-layer';
const BEARING_SOURCE_ID = 'debug-bearing-source';
const BEARING_LAYER_ID_MAIN = 'debug-bearing-layer-main';
const BEARING_LAYER_ID_TOLERANCE = 'debug-bearing-layer-tolerance';

function setupRadiusLayer(map: MaplibreMap) {
  if (map.getSource(RADIUS_SOURCE_ID)) map.removeSource(RADIUS_SOURCE_ID);
  if (map.getLayer(RADIUS_LAYER_ID)) map.removeLayer(RADIUS_LAYER_ID);

  map.addSource(RADIUS_SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: RADIUS_LAYER_ID,
    type: 'fill',
    source: RADIUS_SOURCE_ID,
    paint: {
      'fill-color': [
        'match',
        ['get', 'type'],
        'waypoint',
        '#FF8C00', // DarkOrange for waypoints
        'shaping_point',
        '#00CED1', // DarkTurquoise for shaping points
        '#cccccc', // Default
      ],
      'fill-opacity': 0.3,
      'fill-outline-color': '#000000',
    },
  });
}

function setupBearingLayers(map: MaplibreMap) {
  // Similar setup for bearing source and layers
  // Main bearing line: solid
  // Tolerance lines: dashed, forming a cone
}

export function useDebugMapLayers(mapRef: Ref<MaplibreMap | null>) {
  const debugStore = useDebugStore();

  const updateRadiusVisualsOnMap = (map: MaplibreMap, visuals: DebugRadiusVisualization[]) => {
    if (!map.getSource(RADIUS_SOURCE_ID)) {
      setupRadiusLayer(map);
    }
    const features = visuals.map((v) => turf.circle(v.center, v.radius, { units: 'meters', properties: { id: v.id, type: v.type } }));
    (map.getSource(RADIUS_SOURCE_ID) as maplibregl.GeoJSONSource)?.setData({
      type: 'FeatureCollection',
      features: features,
    });
  };

  const updateBearingVisualsOnMap = (map: MaplibreMap, visuals: DebugBearingVisualization[]) => {
    // ... logic to create LineString features from bearing data ...
    // Use turf.destination to calculate endpoints
    // Set data for BEARING_SOURCE_ID
  };

  const clearAllDebugGeometry = (map: MaplibreMap) => {
    if (map.getSource(RADIUS_SOURCE_ID)) {
      (map.getSource(RADIUS_SOURCE_ID) as maplibregl.GeoJSONSource)?.setData({
        type: 'FeatureCollection',
        features: [],
      });
    }
    // Clear bearing visuals similarly
  };

  watch(
    () => mapRef.value,
    (map) => {
      if (map) {
        // Initial setup if needed when map becomes available
        if (debugStore.showDebugVisuals) {
          setupRadiusLayer(map);
          // setupBearingLayers(map);
          updateRadiusVisualsOnMap(map, debugStore.radiusVisuals);
          // updateBearingVisualsOnMap(map, debugStore.bearingVisuals);
        }
      }
    }
  );

  watch(
    () => debugStore.showDebugVisuals,
    (show) => {
      const map = mapRef.value;
      if (!map) return;
      if (show) {
        setupRadiusLayer(map);
        // setupBearingLayers(map); // Create layers if they don't exist
        updateRadiusVisualsOnMap(map, debugStore.radiusVisuals);
        // updateBearingVisualsOnMap(map, debugStore.bearingVisuals);
      } else {
        clearAllDebugGeometry(map);
        // Optionally remove layers and sources if you want full cleanup
        // if (map.getLayer(RADIUS_LAYER_ID)) map.removeLayer(RADIUS_LAYER_ID);
        // if (map.getSource(RADIUS_SOURCE_ID)) map.removeSource(RADIUS_SOURCE_ID);
        // ... same for bearing layers/sources
      }
    }
  );

  watch(
    () => debugStore.radiusVisuals,
    (visuals) => {
      const map = mapRef.value;
      if (map && debugStore.showDebugVisuals) {
        updateRadiusVisualsOnMap(map, visuals);
      }
    },
    { deep: true }
  );

  watch(
    () => debugStore.bearingVisuals,
    (visuals) => {
      const map = mapRef.value;
      if (map && debugStore.showDebugVisuals) {
        // updateBearingVisualsOnMap(map, visuals);
      }
    },
    { deep: true }
  );
}

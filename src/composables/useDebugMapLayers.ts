// src/composables/useDebugMapLayers.ts
import { watch, type Ref } from 'vue';
import maplibregl, { type Map as MaplibreMap } from 'maplibre-gl';
import * as turf from '@turf/turf';
import type { Feature, LineString, Polygon, FeatureCollection, GeoJsonProperties } from 'geojson';
import { useDebugStore, type DebugRadiusVisualization, type DebugBearingVisualization } from '@/stores/debug.store';

const RADIUS_SOURCE_ID = 'debug-radius-source';
const RADIUS_LAYER_ID = 'debug-radius-layer';
const BEARING_SOURCE_ID = 'debug-bearing-source';
const BEARING_LAYER_ID_MAIN = 'debug-bearing-layer-main';
const BEARING_LAYER_ID_TOLERANCE_CONE = 'debug-bearing-layer-tolerance-cone';

function setupRadiusLayer(map: MaplibreMap) {
  console.log(
    '[useDebugMapLayers] setupRadiusLayer called. Source exists:',
    !!map.getSource(RADIUS_SOURCE_ID),
    'Layer exists:',
    !!map.getLayer(RADIUS_LAYER_ID)
  );
  if (map.getSource(RADIUS_SOURCE_ID)) {
    if (!map.getLayer(RADIUS_LAYER_ID)) {
      console.log('[useDebugMapLayers] Radius source exists, adding layer.');
      map.addLayer({
        id: RADIUS_LAYER_ID,
        type: 'fill',
        source: RADIUS_SOURCE_ID,
        paint: {
          /* ... your paint properties ... */ 'fill-color': ['match', ['get', 'type'], 'waypoint', '#FF8C00', 'shaping_point', '#00CED1', '#cccccc'],
          'fill-opacity': 0.3,
          'fill-outline-color': '#000000',
        },
      });
    }
    return;
  }

  console.log('[useDebugMapLayers] Adding new radius source and layer.');
  map.addSource(RADIUS_SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] } as FeatureCollection,
  });
  map.addLayer({
    id: RADIUS_LAYER_ID,
    type: 'fill',
    source: RADIUS_SOURCE_ID,
    paint: {
      /* ... your paint properties ... */ 'fill-color': ['match', ['get', 'type'], 'waypoint', '#FF8C00', 'shaping_point', '#00CED1', '#cccccc'],
      'fill-opacity': 0.3,
      'fill-outline-color': '#000000',
    },
  });
}

function setupBearingLayers(map: MaplibreMap) {
  console.log(
    '[useDebugMapLayers] setupBearingLayers called. Source exists:',
    !!map.getSource(BEARING_SOURCE_ID),
    'Main layer exists:',
    !!map.getLayer(BEARING_LAYER_ID_MAIN)
  );
  if (map.getSource(BEARING_SOURCE_ID)) {
    if (!map.getLayer(BEARING_LAYER_ID_MAIN)) {
      console.log('[useDebugMapLayers] Bearing source exists, adding main layer.');
      map.addLayer({
        /* ... main bearing layer ... */ id: BEARING_LAYER_ID_MAIN,
        type: 'line',
        source: BEARING_SOURCE_ID,
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': '#FF0000', 'line-width': 2 },
      });
    }
    if (!map.getLayer(BEARING_LAYER_ID_TOLERANCE_CONE)) {
      console.log('[useDebugMapLayers] Bearing source exists, adding tolerance layer.');
      map.addLayer({
        /* ... tolerance cone layer ... */ id: BEARING_LAYER_ID_TOLERANCE_CONE,
        type: 'fill',
        source: BEARING_SOURCE_ID,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#FFA500', 'fill-opacity': 0.2, 'fill-outline-color': '#FF8C00' },
      });
    }
    return;
  }

  console.log('[useDebugMapLayers] Adding new bearing source and layers.');
  map.addSource(BEARING_SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] } as FeatureCollection,
  });
  map.addLayer({
    /* ... main bearing layer ... */ id: BEARING_LAYER_ID_MAIN,
    type: 'line',
    source: BEARING_SOURCE_ID,
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': '#FF0000', 'line-width': 2 },
  });
  map.addLayer({
    /* ... tolerance cone layer ... */ id: BEARING_LAYER_ID_TOLERANCE_CONE,
    type: 'fill',
    source: BEARING_SOURCE_ID,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': '#FFA500', 'fill-opacity': 0.2, 'fill-outline-color': '#FF8C00' },
  });
}

export function useDebugMapLayers(mapRef: Ref<MaplibreMap | null>) {
  const debugStore = useDebugStore();
  console.log('[useDebugMapLayers] Initializing composable. Initial showDebugVisuals:', debugStore.showDebugVisuals);
  const DEFAULT_BEARING_LINE_LENGTH_METERS = 50;

  const updateRadiusVisualsOnMap = (map: MaplibreMap, visuals: DebugRadiusVisualization[]) => {
    console.log(`[useDebugMapLayers] updateRadiusVisualsOnMap CALLED. Visuals count: ${visuals.length}`);
    // console.log('[useDebugMapLayers] updateRadiusVisualsOnMap visuals data:', JSON.stringify(visuals));
    if (!map.getSource(RADIUS_SOURCE_ID)) {
      console.warn('[useDebugMapLayers] Radius source not found in updateRadiusVisualsOnMap! Attempting setup.');
      setupRadiusLayer(map); // Should ideally be setup already if showDebugVisuals is true
    }
    const features: Feature<Polygon>[] = visuals.map((v) => turf.circle(v.center, v.radius, { units: 'meters', properties: { id: v.id, type: v.type } }));
    console.log(`[useDebugMapLayers] updateRadiusVisualsOnMap - Features to set: ${features.length}`);
    // console.log('[useDebugMapLayers] updateRadiusVisualsOnMap - Features data:', JSON.stringify(features));
    const source = map.getSource(RADIUS_SOURCE_ID) as maplibregl.GeoJSONSource;
    if (source) {
      source.setData({
        type: 'FeatureCollection',
        features: features,
      } as FeatureCollection<Polygon>);
    } else {
      console.error('[useDebugMapLayers] updateRadiusVisualsOnMap - FAILED to get source after setup attempt.');
    }
  };

  const updateBearingVisualsOnMap = (map: MaplibreMap, visuals: DebugBearingVisualization[]) => {
    console.log(`[useDebugMapLayers] updateBearingVisualsOnMap CALLED. Visuals count: ${visuals.length}`);
    // console.log('[useDebugMapLayers] updateBearingVisualsOnMap visuals data:', JSON.stringify(visuals));
    if (!map.getSource(BEARING_SOURCE_ID)) {
      console.warn('[useDebugMapLayers] Bearing source not found in updateBearingVisualsOnMap! Attempting setup.');
      setupBearingLayers(map); // Should ideally be setup already if showDebugVisuals is true
    }

    const features: Feature<LineString | Polygon, GeoJsonProperties>[] = [];
    visuals.forEach((v) => {
      const originPoint = turf.point(v.origin);
      const lineLength = v.length ?? DEFAULT_BEARING_LINE_LENGTH_METERS;
      const destinationPoint = turf.destination(originPoint, lineLength / 1000, v.bearing, { units: 'kilometers' });
      features.push(turf.lineString([v.origin, destinationPoint.geometry.coordinates], { id: `${v.id}-main`, vizType: 'bearing-main' }));
      const bearing1 = v.bearing - v.tolerance / 2;
      const bearing2 = v.bearing + v.tolerance / 2;
      const arcPoint1 = turf.destination(originPoint, lineLength / 1000, bearing1, { units: 'kilometers' });
      const arcPoint2 = turf.destination(originPoint, lineLength / 1000, bearing2, { units: 'kilometers' });
      const coneCoordinates = [v.origin, arcPoint1.geometry.coordinates, arcPoint2.geometry.coordinates, v.origin];
      features.push(turf.polygon([coneCoordinates], { id: `${v.id}-tolerance`, vizType: 'bearing-cone' }));
    });
    console.log(`[useDebugMapLayers] updateBearingVisualsOnMap - Features to set: ${features.length}`);
    // console.log('[useDebugMapLayers] updateBearingVisualsOnMap - Features data:', JSON.stringify(features));
    const source = map.getSource(BEARING_SOURCE_ID) as maplibregl.GeoJSONSource;
    if (source) {
      source.setData({
        type: 'FeatureCollection',
        features: features,
      } as FeatureCollection<LineString | Polygon>);
    } else {
      console.error('[useDebugMapLayers] updateBearingVisualsOnMap - FAILED to get source after setup attempt.');
    }
  };

  const clearAllDebugGeometry = (map: MaplibreMap) => {
    console.log('[useDebugMapLayers] clearAllDebugGeometry CALLED.');
    const emptyFc: FeatureCollection = { type: 'FeatureCollection', features: [] };
    const radiusSource = map.getSource(RADIUS_SOURCE_ID) as maplibregl.GeoJSONSource;
    if (radiusSource) radiusSource.setData(emptyFc);
    const bearingSource = map.getSource(BEARING_SOURCE_ID) as maplibregl.GeoJSONSource;
    if (bearingSource) bearingSource.setData(emptyFc);
  };

  watch(
    () => mapRef.value,
    (map) => {
      console.log('[useDebugMapLayers] mapRef watcher triggered. Map instance:', map ? 'available' : 'null');
      if (map) {
        console.log('[useDebugMapLayers] mapRef watcher: Map is now available. Current showDebugVisuals state:', debugStore.showDebugVisuals);
        if (debugStore.showDebugVisuals) {
          console.log('[useDebugMapLayers] mapRef watcher: showDebugVisuals is true, ensuring layers and data are set.');
          setupRadiusLayer(map);
          setupBearingLayers(map);
          updateRadiusVisualsOnMap(map, debugStore.radiusVisuals);
          updateBearingVisualsOnMap(map, debugStore.bearingVisuals);
        }
      }
    }
  );

  watch(
    () => debugStore.showDebugVisuals,
    (show) => {
      const map = mapRef.value;
      console.log(`[useDebugMapLayers] showDebugVisuals watcher triggered. New value: ${show}. Map instance: ${map ? 'available' : 'null'}`);
      if (!map) {
        console.log('[useDebugMapLayers] showDebugVisuals watcher: Map not available yet, returning.');
        return;
      }
      if (show) {
        console.log('[useDebugMapLayers] showDebugVisuals watcher: "show" is true. Setting up layers and updating visuals.');
        setupRadiusLayer(map);
        setupBearingLayers(map);
        updateRadiusVisualsOnMap(map, debugStore.radiusVisuals);
        updateBearingVisualsOnMap(map, debugStore.bearingVisuals);
      } else {
        console.log('[useDebugMapLayers] showDebugVisuals watcher: "show" is false. Clearing all debug geometry.');
        clearAllDebugGeometry(map);
      }
    },
    { immediate: true }
  );

  watch(
    () => [...debugStore.radiusVisuals], // Watching a copy to better detect changes in array content
    (visuals) => {
      const map = mapRef.value;
      console.log(
        `[useDebugMapLayers] radiusVisuals watcher triggered. Visuals count: ${visuals.length}. Map: ${map ? 'available' : 'null'}. ShowDebug: ${
          debugStore.showDebugVisuals
        }`
      );
      if (map && debugStore.showDebugVisuals) {
        updateRadiusVisualsOnMap(map, visuals);
      }
    },
    { deep: true } // deep is still useful for objects within the array
  );

  watch(
    () => [...debugStore.bearingVisuals], // Watching a copy
    (visuals) => {
      const map = mapRef.value;
      console.log(
        `[useDebugMapLayers] bearingVisuals watcher triggered. Visuals count: ${visuals.length}. Map: ${map ? 'available' : 'null'}. ShowDebug: ${
          debugStore.showDebugVisuals
        }`
      );
      if (map && debugStore.showDebugVisuals) {
        updateBearingVisualsOnMap(map, visuals);
      }
    },
    { deep: true }
  );
}

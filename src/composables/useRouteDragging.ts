// src/composables/useRouteDragging.ts
import { onMounted, onBeforeUnmount, type Ref, ref } from 'vue';
import maplibregl, { type MapLayerMouseEvent, type MapMouseEvent, type Map as MaplibreMap } from 'maplibre-gl';
import { useRouteStore } from '@/stores/route.store';
import { useMapMarkers } from '@/composables/useMapMarkers';
import { SEGMENTS_BASE_LAYER } from '@/config/map.config';
import { getRadiusForZoom } from '@/utils/mapHelpers';

export function useRouteDragging(options: { map: Ref<MaplibreMap | null> }) {
  const routeStore = useRouteStore();
  const { createTempMarker } = useMapMarkers(options.map);

  let onDownListener: ((e: MapLayerMouseEvent) => void) | null = null;
  let onMoveListener: ((e: MapMouseEvent) => void) | null = null;
  let windowOnUpListener: ((this: Window, ev: MouseEvent) => any) | null = null;

  let tempShapingMarker: maplibregl.Marker | null = null;
  const isDragging = ref(false);
  const currentSegmentIdx = ref<number | null>(null);

  const cleanupDragState = (mapInstance?: MaplibreMap | null) => {
    const m = mapInstance || options.map.value;
    if (tempShapingMarker) {
      tempShapingMarker.remove();
      tempShapingMarker = null;
    }
    if (m && onMoveListener) {
      m.off('mousemove', onMoveListener);
    }
    if (windowOnUpListener) {
      window.removeEventListener('mouseup', windowOnUpListener);
      windowOnUpListener = null;
    }

    onMoveListener = null;

    if (m?.dragPan) {
      try {
        m.dragPan.enable();
      } catch (err) {
        // console.warn("Could not enable dragPan, map might be unmounted.", err);
      }
    }
    isDragging.value = false;
    currentSegmentIdx.value = null;
  };

  onMounted(() => {
    const mapInstance = options.map.value;
    if (!mapInstance) return;

    onDownListener = (e: MapLayerMouseEvent) => {
      const m = options.map.value;
      if (!routeStore.route || !m || e.defaultPrevented || e.originalEvent.button !== 0) {
        return;
      }

      const feature = e.features?.[0];
      const featIdx = feature?.properties?.idx as number | undefined;

      if (featIdx == null) {
        return;
      }

      if ((e.originalEvent.target as HTMLElement)?.closest('.maplibregl-marker')) {
        return;
      }

      e.preventDefault();
      if (m.dragPan) m.dragPan.disable();

      currentSegmentIdx.value = featIdx;
      isDragging.value = true;

      if (tempShapingMarker) tempShapingMarker.remove();
      tempShapingMarker = createTempMarker([e.lngLat.lng, e.lngLat.lat], 'temp-shaping');

      onMoveListener = (ev: MapMouseEvent) => {
        if (!isDragging.value || !tempShapingMarker) return;
        tempShapingMarker.setLngLat(ev.lngLat);
      };
      m.on('mousemove', onMoveListener);

      windowOnUpListener = async (ev: MouseEvent) => {
        if (!isDragging.value) {
          cleanupDragState(m);
          return;
        }

        const finalLngLat = tempShapingMarker?.getLngLat();
        const currentMapInstance = options.map.value; // Use the reactive ref to get current map instance

        if (currentSegmentIdx.value != null && finalLngLat && currentMapInstance) {
          const zoom = currentMapInstance.getZoom();
          const calculatedRadius = getRadiusForZoom(zoom);

          console.log(
            `[useRouteDragging] mouseup - Inserting shaping point after segment ${currentSegmentIdx.value}, at ${finalLngLat.lng}, ${
              finalLngLat.lat
            } with radius ${calculatedRadius}m (Zoom: ${zoom.toFixed(2)})`
          );

          // Call the updated store action with the calculated radius
          await routeStore.insertShapingPoint(
            currentSegmentIdx.value + 1, // originalSegmentIdxPlusOne
            [finalLngLat.lng, finalLngLat.lat],
            calculatedRadius
          );
        }
        cleanupDragState(currentMapInstance); // Pass the map instance used for getZoom
      };
      window.addEventListener('mouseup', windowOnUpListener, { once: true });
    };
    mapInstance.on('mousedown', SEGMENTS_BASE_LAYER, onDownListener);
  });

  onBeforeUnmount(() => {
    const m = options.map.value;
    cleanupDragState(m);
    if (onDownListener && m) {
      m.off('mousedown', SEGMENTS_BASE_LAYER, onDownListener);
    }
  });
}

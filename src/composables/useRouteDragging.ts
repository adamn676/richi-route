import { onBeforeUnmount, watch, type Ref } from 'vue';
import type {
  Map as MaplibreMap,
  MapLayerMouseEvent,
  MapLayerTouchEvent,
  MapMouseEvent,
  MapTouchEvent,
  Marker,
} from 'maplibre-gl';
import { SEGMENTS_BASE_LAYER } from '@/config/map.config';
import { createPreviewMarker } from '@/composables/useMapMarkers';
import { useRouteStore } from '@/stores/route.store';
import { useStreetViewStore } from '@/stores/street-view.store';

interface DragState {
  fromId: string;
  toId: string;
  start: { x: number; y: number };
  marker: Marker;
  moved: boolean;
  restorePan: boolean;
}

const suppressedClicks = new WeakMap<MaplibreMap, { x: number; y: number; until: number }>();

export function consumeRouteDragClick(map: MaplibreMap, point: { x: number; y: number }): boolean {
  const suppressed = suppressedClicks.get(map);
  if (!suppressed) return false;
  suppressedClicks.delete(map);
  return performance.now() < suppressed.until && Math.hypot(point.x - suppressed.x, point.y - suppressed.y) < 20;
}

export function useRouteDragging(options: { map: Ref<MaplibreMap | null> }): void {
  const routeStore = useRouteStore();
  const streetView = useStreetViewStore();
  let drag: DragState | null = null;

  function onMouseMove(event: MapMouseEvent): void {
    move(event);
  }
  function onTouchMove(event: MapTouchEvent): void {
    if (event.points.length !== 1) {
      cleanup();
      return;
    }
    move(event);
  }
  function move(event: MapMouseEvent | MapTouchEvent): void {
    if (!drag) return;
    if (Math.hypot(event.point.x - drag.start.x, event.point.y - drag.start.y) >= 6) {
      drag.moved = true;
    }
    if (drag.moved) drag.marker.setLngLat(event.lngLat);
  }

  function cleanup(): void {
    const map = options.map.value;
    map?.off('mousemove', onMouseMove);
    map?.off('touchmove', onTouchMove);
    map?.off('mouseup', finish);
    map?.off('touchend', finish);
    map?.off('touchcancel', cleanup);
    window.removeEventListener('mouseup', finish);
    window.removeEventListener('touchend', finish);
    if (drag?.restorePan) map?.dragPan.enable();
    drag?.marker.remove();
    drag = null;
  }

  function finish(): void {
    const current = drag;
    const map = options.map.value;
    if (current && map && current.moved) {
      const position = current.marker.getLngLat();
      const pixel = map.project(position);
      suppressedClicks.set(map, { x: pixel.x, y: pixel.y, until: performance.now() + 700 });
      try {
        routeStore.insertShapingPoint(current.fromId, current.toId, [position.lng, position.lat]);
      } catch (error) {
        console.error('Formpunkt konnte nicht gesetzt werden:', error);
        routeStore.errorMessage = error instanceof Error ? error.message : 'Formpunkt konnte nicht gesetzt werden.';
      }
    }
    cleanup();
  }

  function start(event: MapLayerMouseEvent | MapLayerTouchEvent): void {
    const map = options.map.value;
    // While a Street View spot is being chosen, the route takes clicks instead of drags.
    if (!map || drag || !routeStore.route || streetView.picking) return;
    if (event.type === 'mousedown' && event.originalEvent instanceof MouseEvent && event.originalEvent.button !== 0) return;
    const feature = event.features?.[0];
    const { fromId, toId } = feature?.properties ?? {};
    if (typeof fromId !== 'string' || typeof toId !== 'string') return;
    if (event.originalEvent.target instanceof HTMLElement && event.originalEvent.target.closest('.maplibregl-marker')) return;

    event.preventDefault();
    const restorePan = map.dragPan.isEnabled();
    if (restorePan) map.dragPan.disable();
    drag = {
      fromId,
      toId,
      start: { x: event.point.x, y: event.point.y },
      marker: createPreviewMarker(map, [event.lngLat.lng, event.lngLat.lat]),
      moved: false,
      restorePan,
    };
    map.on('mousemove', onMouseMove);
    map.on('touchmove', onTouchMove);
    map.on('mouseup', finish);
    map.on('touchend', finish);
    map.on('touchcancel', cleanup);
    window.addEventListener('mouseup', finish, { once: true });
    window.addEventListener('touchend', finish, { once: true });
  }

  function onMouseDown(event: MapLayerMouseEvent): void { start(event); }
  function onTouchStart(event: MapLayerTouchEvent): void { start(event); }
  function onHover(): void { if (options.map.value) options.map.value.getCanvas().style.cursor = 'grab'; }
  function onLeave(): void { if (options.map.value) options.map.value.getCanvas().style.cursor = ''; }

  watch(options.map, (map, previous) => {
    previous?.off('mousedown', SEGMENTS_BASE_LAYER, onMouseDown);
    previous?.off('touchstart', SEGMENTS_BASE_LAYER, onTouchStart);
    previous?.off('mouseenter', SEGMENTS_BASE_LAYER, onHover);
    previous?.off('mouseleave', SEGMENTS_BASE_LAYER, onLeave);
    if (!map) return;
    map.on('mousedown', SEGMENTS_BASE_LAYER, onMouseDown);
    map.on('touchstart', SEGMENTS_BASE_LAYER, onTouchStart);
    map.on('mouseenter', SEGMENTS_BASE_LAYER, onHover);
    map.on('mouseleave', SEGMENTS_BASE_LAYER, onLeave);
  }, { immediate: true });

  onBeforeUnmount(() => {
    cleanup();
    const map = options.map.value;
    map?.off('mousedown', SEGMENTS_BASE_LAYER, onMouseDown);
    map?.off('touchstart', SEGMENTS_BASE_LAYER, onTouchStart);
    map?.off('mouseenter', SEGMENTS_BASE_LAYER, onHover);
    map?.off('mouseleave', SEGMENTS_BASE_LAYER, onLeave);
  });
}

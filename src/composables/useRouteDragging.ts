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
  touch: boolean;
}

const suppressedClicks = new WeakMap<MaplibreMap, { x: number; y: number; until: number }>();
const dragging = new WeakSet<MaplibreMap>();
// MapLibre turns a finger held still into a contextmenu (Street View), also while it drags the route.
export const isDraggingRoute = (map: MaplibreMap) => dragging.has(map);

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
    if (map) dragging.delete(map);
    drag?.marker.remove();
    drag = null;
  }

  function finish(): void {
    const current = drag;
    const map = options.map.value;
    // A finger held on the route and lifted again sets no stop either.
    if (current && map && (current.moved || current.touch)) {
      const position = current.marker.getLngLat();
      const pixel = map.project(position);
      suppressedClicks.set(map, { x: pixel.x, y: pixel.y, until: performance.now() + 700 });
      if (current.moved) try {
        routeStore.insertShapingPoint(current.fromId, current.toId, [position.lng, position.lat]);
      } catch (error) {
        console.error('Formpunkt konnte nicht gesetzt werden:', error);
        routeStore.errorMessage = error instanceof Error ? error.message : 'Formpunkt konnte nicht gesetzt werden.';
      }
    }
    cleanup();
  }

  // The route section under the pointer, unless a marker lies on top or a point is being picked (Street View, a stretch
  // to report), which takes clicks.
  function sectionAt(event: MapLayerMouseEvent | MapLayerTouchEvent) {
    if (drag || !routeStore.route || streetView.picking || routeStore.surfaceReporting) return null;
    if (event.originalEvent.target instanceof HTMLElement && event.originalEvent.target.closest('.maplibregl-marker')) return null;
    const { fromId, toId } = event.features?.[0]?.properties ?? {};
    return typeof fromId === 'string' && typeof toId === 'string' ? { fromId, toId, point: event.point, lngLat: event.lngLat } : null;
  }

  function start(map: MaplibreMap, section: NonNullable<ReturnType<typeof sectionAt>>, touch: boolean): void {
    const restorePan = map.dragPan.isEnabled();
    if (restorePan) map.dragPan.disable();
    drag = {
      fromId: section.fromId,
      toId: section.toId,
      start: { x: section.point.x, y: section.point.y },
      marker: createPreviewMarker(map, [section.lngLat.lng, section.lngLat.lat]),
      moved: false,
      restorePan,
      touch,
    };
    map.on('mousemove', onMouseMove);
    map.on('touchmove', onTouchMove);
    map.on('mouseup', finish);
    map.on('touchend', finish);
    map.on('touchcancel', cleanup);
    window.addEventListener('mouseup', finish, { once: true });
    window.addEventListener('touchend', finish, { once: true });
    dragging.add(map);
  }

  function onMouseDown(event: MapLayerMouseEvent): void {
    const map = options.map.value, section = sectionAt(event);
    if (!map || !section || event.originalEvent.button !== 0) return;
    event.preventDefault();
    start(map, section, false);
  }
  // A finger on the route pans the map as anywhere else; held still for a moment, it picks the route up. A pan, a lift
  // or a second finger before then cancels that, and so does a route changed meanwhile.
  let press: ReturnType<typeof setTimeout> | undefined;
  function onTouchStart(event: MapLayerTouchEvent): void {
    const map = options.map.value, section = sectionAt(event);
    if (!map || !section || event.points.length !== 1) return;
    const timer = press = setTimeout(() => {
      const current = routeStore.route?.features.some(({ properties }) => properties.fromId === section.fromId && properties.toId === section.toId);
      if (map.isMoving() || drag || streetView.picking || routeStore.surfaceReporting || !current) return;
      navigator.vibrate?.(15);
      start(map, section, true);
    }, 400);
    // On the element, unlike map.once, a listener added now misses the touch that is starting.
    const cancel = () => clearTimeout(timer);
    for (const type of ['touchstart', 'touchend', 'touchcancel']) map.getCanvasContainer().addEventListener(type, cancel, { once: true });
  }
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
    clearTimeout(press);
    cleanup();
    const map = options.map.value;
    map?.off('mousedown', SEGMENTS_BASE_LAYER, onMouseDown);
    map?.off('touchstart', SEGMENTS_BASE_LAYER, onTouchStart);
    map?.off('mouseenter', SEGMENTS_BASE_LAYER, onHover);
    map?.off('mouseleave', SEGMENTS_BASE_LAYER, onLeave);
  });
}

import { h, onBeforeUnmount, render, watch, type Ref } from 'vue';
import { Marker, Popup, type Map as MaplibreMap, type MapMouseEvent, type PointLike } from 'maplibre-gl';
import { SEGMENTS_BASE_LAYER } from '@/config/map.config';
import { isDraggingRoute } from '@/composables/useRouteDragging';
import type { Coord } from '@/domain/route-model';
import { IconMan } from '@/components/icons';
import { useStreetViewStore } from '@/stores/street-view.store';
import { useOfflineAreasStore } from '@/stores/offline-areas.store';
import { streetViewUrl } from '@/utils/street-view';

// The point on the route closest to a screen point, within `radius` pixels, so Street View picks land on the track.
export function routePointNear(map: MaplibreMap, point: { x: number; y: number }, radius = 16): Coord | null {
  if (!map.getLayer(SEGMENTS_BASE_LAYER)) return null;
  const box: [PointLike, PointLike] = [[point.x - radius, point.y - radius], [point.x + radius, point.y + radius]];
  let best: { distance: number; x: number; y: number } | undefined;
  for (const feature of map.queryRenderedFeatures(box, { layers: [SEGMENTS_BASE_LAYER] })) {
    if (feature.geometry.type !== 'LineString') continue;
    const line = feature.geometry.coordinates.map(coord => map.project(coord as Coord));
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], dx = line[i].x - a.x, dy = line[i].y - a.y, length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0;
      const x = a.x + t * dx, y = a.y + t * dy, distance = Math.hypot(point.x - x, point.y - y);
      if (distance <= radius && (!best || distance < best.distance)) best = { distance, x, y };
    }
  }
  return best ? map.unproject([best.x, best.y]).toArray() as Coord : null;
}

function figure<T extends HTMLElement>(element: T, size: number): T {
  render(h(IconMan, { size, 'aria-hidden': 'true' }), element);
  return element;
}

// Street View on the map: a right-click (or long press) offers it anywhere, and while a spot is being chosen
// a figure follows the pointer and snaps onto the route nearby. Both grey out where Google has no imagery.
// The click itself is handled by useMapInteractions.
export function useStreetViewMap(mapRef: Ref<MaplibreMap | null>): void {
  const streetView = useStreetViewStore();
  const offline = useOfflineAreasStore();
  let popup: Popup | undefined;
  // A pin whose tip marks the spot, so the pointer's crosshair never covers the figure.
  const marker = new Marker({ element: figure(Object.assign(document.createElement('div'), { className: 'street-view-marker' }), 18),
    anchor: 'bottom', offset: [0, -6] });
  let markerShown = false;

  function offer(event: MapMouseEvent): void {
    event.originalEvent.preventDefault();
    if (isDraggingRoute(event.target) || offline.active) return;
    const coord: Coord = [event.lngLat.lng, event.lngLat.lat];
    // A menu with one entry, as the planner's other menus look.
    const link = figure(Object.assign(document.createElement('a'), {
      href: streetViewUrl(coord), target: '_blank', rel: 'noopener noreferrer', className: 'street-view-link',
    }), 18);
    const label = link.appendChild(Object.assign(document.createElement('span'), { textContent: 'Street View' }));
    link.addEventListener('click', click => { streetView.open(click, coord); if (!link.ariaDisabled) popup?.remove(); });
    streetView.imageryNear(coord).then(imagery => {
      if (imagery !== null) return;
      label.textContent = 'Kein Street View hier';
      link.ariaDisabled = 'true';
    });
    popup?.remove();
    popup = new Popup({ closeButton: false, offset: 6, className: 'map-menu-popup' }).setLngLat(event.lngLat).setDOMContent(link).addTo(event.target);
    // It closes as a menu does: on Escape or a press anywhere else, not only on the map.
    document.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', dismiss, true);
    popup.on('close', () => {
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('pointerdown', dismiss, true);
    });
  }
  function dismiss(event: Event): void {
    const outside = event instanceof KeyboardEvent ? event.key === 'Escape' : !popup?.getElement().contains(event.target as Node);
    if (outside) popup?.remove();
  }
  function follow(event: MapMouseEvent): void {
    if (streetView.picking) streetView.spot = routePointNear(event.target, event.point) ?? event.lngLat.toArray() as Coord;
  }
  function hide(): void {
    if (streetView.picking) streetView.spot = null;
  }
  // The pin stands where Street View would open, also where a tap on a phone found no imagery.
  watch(() => streetView.picking ? streetView.spot : null, coord => {
    if (!coord) { marker.remove(); markerShown = false; return; }
    marker.setLngLat(coord);
    if (!markerShown && mapRef.value) { marker.addTo(mapRef.value); markerShown = true; }
  });
  // Greyed out where Google has no imagery.
  watch(() => streetView.missing, missing => marker.getElement().classList.toggle('street-view-marker--missing', missing));
  watch(mapRef, (map, previous) => {
    previous?.off('contextmenu', offer); previous?.off('mousemove', follow); previous?.off('mouseout', hide);
    map?.on('contextmenu', offer); map?.on('mousemove', follow); map?.on('mouseout', hide);
  }, { immediate: true });
  onBeforeUnmount(() => {
    const map = mapRef.value;
    map?.off('contextmenu', offer); map?.off('mousemove', follow); map?.off('mouseout', hide);
    popup?.remove(); marker.remove();
  });
}

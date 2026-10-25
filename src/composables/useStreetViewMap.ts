import { h, onBeforeUnmount, render, watch, type Ref } from 'vue';
import { Marker, Popup, type Map as MaplibreMap, type MapMouseEvent, type PointLike } from 'maplibre-gl';
import { SEGMENTS_BASE_LAYER } from '@/config/map.config';
import type { Coord } from '@/domain/route-model';
import { IconMan } from '@/components/icons';
import { useStreetViewStore } from '@/stores/street-view.store';
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
  let popup: Popup | undefined;
  // A pin whose tip marks the spot, so the pointer's crosshair never covers the figure.
  const marker = new Marker({ element: figure(Object.assign(document.createElement('div'), { className: 'street-view-marker' }), 18),
    anchor: 'bottom', offset: [0, -6] });
  let markerShown = false;

  function offer(event: MapMouseEvent): void {
    event.originalEvent.preventDefault();
    const coord: Coord = [event.lngLat.lng, event.lngLat.lat];
    const link = figure(Object.assign(document.createElement('a'), {
      href: streetViewUrl(coord), target: '_blank', rel: 'noopener noreferrer', className: 'street-view-link', title: 'Street View',
    }), 22);
    link.setAttribute('aria-label', 'Street View');
    link.addEventListener('click', click => { streetView.open(click, coord); if (!link.ariaDisabled) popup?.remove(); });
    streetView.imageryNear(coord).then(imagery => {
      if (imagery !== null) return;
      link.title = link.ariaLabel = 'Kein Street View hier';
      link.ariaDisabled = 'true';
    });
    popup?.remove();
    popup = new Popup({ closeButton: false, offset: 6 }).setLngLat(event.lngLat).setDOMContent(link).addTo(event.target);
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

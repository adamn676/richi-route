import type { Ref } from 'vue';
import { Marker, type Map as MaplibreMap } from 'maplibre-gl';
import { stopBadge, stopLabel, type Coord, type ShapePoint, type Waypoint } from '@/domain/route-model';
import { useRouteStore } from '@/stores/route.store';

function markerElement(kind: 'stop' | 'shape' | 'preview'): HTMLElement {
  const element = document.createElement('div');
  element.className = `route-marker route-marker--${kind}`;
  if (kind !== 'stop') element.setAttribute('aria-label', kind === 'shape' ? 'Formpunkt verschieben' : 'Neuer Formpunkt');
  return element;
}

// A stop that found no street shows red, as its row does.
function labelStop(element: HTMLElement, point: Waypoint, index: number): HTMLElement {
  element.textContent = stopBadge(point.kind, index);
  element.setAttribute('aria-label', `${stopLabel(point.kind, index)} verschieben`);
  element.classList.toggle('route-marker--error', Boolean(useRouteStore().stopError(point)));
  return element;
}

export function createPreviewMarker(map: MaplibreMap, coord: Coord): Marker {
  return new Marker({ element: markerElement('preview') }).setLngLat(coord).addTo(map);
}

export function useMapMarkers(mapRef: Ref<MaplibreMap | null>) {
  const routeStore = useRouteStore();
  const waypointMarkers = new Map<string, Marker>();
  const shapeMarkers = new Map<string, Marker>();

  function createWaypointMarkers(waypoints: (Waypoint & { coord: Coord })[]): void {
    const map = mapRef.value;
    if (!map) return;
    const ids = new Set(waypoints.map((point) => point.id));
    for (const [id, marker] of waypointMarkers) {
      if (!ids.has(id)) {
        marker.remove();
        waypointMarkers.delete(id);
      }
    }

    for (const point of waypoints) {
      const index = routeStore.waypoints.findIndex(item => item.id === point.id);
      let marker = waypointMarkers.get(point.id);
      if (!marker) {
        marker = new Marker({ element: labelStop(markerElement('stop'), point, index), draggable: true })
          .setLngLat(point.coord)
          .addTo(map);
        marker.on('dragend', () => {
          const position = marker!.getLngLat();
          try {
            routeStore.updateWaypointCoord(point.id, [position.lng, position.lat]);
          } catch (error) {
            console.error('Stopp konnte nicht verschoben werden:', error);
            routeStore.errorMessage = error instanceof Error ? error.message : 'Stopp konnte nicht verschoben werden.';
          }
        });
        waypointMarkers.set(point.id, marker);
      } else {
        marker.setLngLat(point.coord);
        labelStop(marker.getElement(), point, index);
      }
    }
  }

  function createShapingMarkers(shapes: ShapePoint[]): void {
    const map = mapRef.value;
    if (!map) return;
    const ids = new Set(shapes.map((point) => point.id));
    for (const [id, marker] of shapeMarkers) {
      if (!ids.has(id)) {
        marker.remove();
        shapeMarkers.delete(id);
      }
    }

    shapes.forEach((shape) => {
      let marker = shapeMarkers.get(shape.id);
      if (!marker) {
        marker = new Marker({ element: markerElement('shape'), draggable: true })
          .setLngLat(shape.coord)
          .addTo(map);
        marker.on('dragend', () => {
          const position = marker!.getLngLat();
          try {
            routeStore.updateShapingPointCoord(shape.id, [position.lng, position.lat]);
          } catch (error) {
            console.error('Formpunkt konnte nicht verschoben werden:', error);
            routeStore.errorMessage = error instanceof Error ? error.message : 'Formpunkt konnte nicht verschoben werden.';
          }
        });
        shapeMarkers.set(shape.id, marker);
      } else {
        marker.setLngLat(shape.coord);
      }
    });
  }

  function clearAllMarkers(): void {
    for (const marker of waypointMarkers.values()) marker.remove();
    for (const marker of shapeMarkers.values()) marker.remove();
    waypointMarkers.clear();
    shapeMarkers.clear();
  }

  return { createWaypointMarkers, createShapingMarkers, clearAllMarkers };
}

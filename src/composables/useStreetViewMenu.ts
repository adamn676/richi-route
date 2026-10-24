import { onBeforeUnmount, watch, type Ref } from 'vue';
import { Popup, type Map as MaplibreMap, type MapMouseEvent } from 'maplibre-gl';
import { streetViewUrl } from '@/utils/street-view';
import { useStreetViewStore } from '@/stores/street-view.store';

// A right-click, or a long press on phones, offers Google Street View at that point of the map or route.
export function useStreetViewMenu(mapRef: Ref<MaplibreMap | null>): void {
  const streetView = useStreetViewStore();
  let popup: Popup | undefined;
  function open(event: MapMouseEvent): void {
    event.originalEvent.preventDefault();
    const coord: [number, number] = [event.lngLat.lng, event.lngLat.lat];
    const link = Object.assign(document.createElement('a'), {
      href: streetViewUrl(coord), target: '_blank', rel: 'noopener noreferrer',
      className: 'street-view-link', textContent: 'Google Street View öffnen',
    });
    link.addEventListener('click', click => { streetView.open(click, coord); popup?.remove(); });
    popup?.remove();
    popup = new Popup({ closeButton: false, offset: 6 }).setLngLat(event.lngLat).setDOMContent(link).addTo(event.target);
  }
  watch(mapRef, (map, previous) => {
    previous?.off('contextmenu', open);
    map?.on('contextmenu', open);
  }, { immediate: true });
  onBeforeUnmount(() => { mapRef.value?.off('contextmenu', open); popup?.remove(); });
}

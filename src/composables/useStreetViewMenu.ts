import { onBeforeUnmount, watch, type Ref } from 'vue';
import { Popup, type Map as MaplibreMap, type MapMouseEvent } from 'maplibre-gl';
import { streetViewUrl } from '@/utils/street-view';

// A right-click, or a long press on phones, offers Google Street View at that point of the map or route.
export function useStreetViewMenu(mapRef: Ref<MaplibreMap | null>): void {
  let popup: Popup | undefined;
  function open(event: MapMouseEvent): void {
    event.originalEvent.preventDefault();
    const link = Object.assign(document.createElement('a'), {
      href: streetViewUrl([event.lngLat.lng, event.lngLat.lat]), target: '_blank', rel: 'noopener noreferrer',
      className: 'street-view-link', textContent: 'Google Street View öffnen',
    });
    link.addEventListener('click', () => popup?.remove());
    popup?.remove();
    popup = new Popup({ closeButton: false, offset: 6 }).setLngLat(event.lngLat).setDOMContent(link).addTo(event.target);
  }
  watch(mapRef, (map, previous) => {
    previous?.off('contextmenu', open);
    map?.on('contextmenu', open);
  }, { immediate: true });
  onBeforeUnmount(() => { mapRef.value?.off('contextmenu', open); popup?.remove(); });
}

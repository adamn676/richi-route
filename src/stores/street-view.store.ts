import { computed, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { Coord } from '@/domain/route-model';

// With a Google Maps Embed API key, Street View shows inside the app in place of the map;
// without one, Street View links open Google Maps in a new tab.
const embedKey = import.meta.env?.VITE_GOOGLE_MAPS_EMBED_KEY?.trim() ?? '';

export const useStreetViewStore = defineStore('street-view', () => {
  const location = shallowRef<Coord | null>(null);
  const src = computed(() => location.value && 'https://www.google.com/maps/embed/v1/streetview?key='
    + `${encodeURIComponent(embedKey)}&location=${location.value[1].toFixed(6)},${location.value[0].toFixed(6)}`);
  // Street View links call this: with embedding set up, the panel replaces following the link.
  function open(event: MouseEvent, coord: Coord) {
    if (!embedKey) return;
    event.preventDefault();
    location.value = coord;
  }
  return { location, src, open, close: () => { location.value = null; } };
});

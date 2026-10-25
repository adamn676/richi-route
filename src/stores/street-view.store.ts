import { computed, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import type { Coord } from '@/domain/route-model';
import { streetViewUrl } from '@/utils/street-view';
import { useRouteProfileStore } from './route-profile.store';

// With a Google Maps Embed API key, Street View shows inside the app in place of the map;
// without one, Street View links open Google Maps in a new tab.
const embedKey = import.meta.env?.VITE_GOOGLE_MAPS_EMBED_KEY?.trim() ?? '';

// The nearest panorama within 50 m, null where Google has none, undefined when that is unknown
// (no key, offline, or the key lacks the Street View Static API). These metadata lookups are free.
type Imagery = Coord | null | undefined;

export const useStreetViewStore = defineStore('street-view', () => {
  const profile = useRouteProfileStore();
  const location = shallowRef<Coord | null>(null);
  // Where on the route Street View was opened, if on it; it then looks along the route.
  const routeDistance = ref<number | null>(null);
  const heading = ref<number | null>(null);
  // While picking, the next map click shows Street View there instead of placing a waypoint.
  const picking = ref(false);
  const src = computed(() => location.value && 'https://www.google.com/maps/embed/v1/streetview?key='
    + `${encodeURIComponent(embedKey)}&location=${location.value[1].toFixed(6)},${location.value[0].toFixed(6)}&language=de&region=AT`
    + (heading.value === null ? '' : `&heading=${Math.round(heading.value)}&pitch=0`));

  const lookups = new Map<string, Promise<Imagery>>();
  let lookupsAllowed = Boolean(embedKey);
  function imageryNear([lng, lat]: Coord): Promise<Imagery> {
    if (!lookupsAllowed) return Promise.resolve(undefined);
    // Points about 10 m apart share one lookup.
    const point = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    let lookup = lookups.get(point);
    if (!lookup) {
      lookup = fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${point}&radius=50&source=outdoor&key=${encodeURIComponent(embedKey)}`)
        .then(response => response.json())
        .then(({ status, location }: { status: string; location?: { lat: number; lng: number } }) => {
          if (status === 'OK' && location) return [location.lng, location.lat] as Coord;
          if (status === 'ZERO_RESULTS') return null;
          // Without access to the lookup, Street View still opens, just unchecked.
          if (status === 'REQUEST_DENIED') lookupsAllowed = false;
          return undefined;
        }, () => undefined);
      lookups.set(point, lookup);
    }
    return lookup;
  }

  // The spot Street View would open at (the picking figure or the pinned profile position), checked while it moves:
  // one lookup at a time, each for the latest spot, so the answer keeps up without a request per pixel.
  const spot = shallowRef<Coord | null>(null);
  const imagery = shallowRef<Imagery>();
  let checking = false;
  async function check() {
    const coord = spot.value;
    if (!coord) { imagery.value = undefined; return; }
    if (checking) return;
    checking = true;
    imagery.value = await imageryNear(coord);
    checking = false;
    if (spot.value !== coord) check();
  }
  watch(spot, check);
  watch(picking, value => { if (!value) spot.value = null; });

  // Street View links call this: with embedding set up, the panel replaces following the link.
  function open(event: MouseEvent, coord: Coord, distance?: number) {
    if (!embedKey) return;
    event.preventDefault();
    show(coord, distance);
  }
  // Opens at the nearest panorama; where there is none, nothing opens and picking goes on.
  async function show(coord: Coord, distance = profile.distanceNear(coord)) {
    if (!embedKey) {
      picking.value = false;
      window.open(streetViewUrl(coord), '_blank', 'noopener');
      return;
    }
    const panorama = await imageryNear(coord);
    // A tap has no hover, so the spot it missed shows as such.
    if (panorama === null) { if (picking.value) spot.value = coord; return; }
    picking.value = false;
    routeDistance.value = distance;
    heading.value = distance === null ? null : profile.headingAt(distance);
    location.value = panorama ?? coord;
  }
  function close() {
    location.value = null;
    routeDistance.value = heading.value = null;
  }
  return { location, routeDistance, picking, spot, missing: computed(() => imagery.value === null), src, imageryNear, open, show, close };
});

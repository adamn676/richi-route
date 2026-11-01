import { ref, watch, type ShallowRef } from 'vue';
import type { ExpressionSpecification, Map } from 'maplibre-gl';
import { ridesStyle } from '@/config/mapStyle';
import { absoluteUrl } from '@/utils/url';

const shownKey = 'richiroute.rides';
const most = Math.log(100);

// "Richi Fahrten": the roads the rider took on their own rides (npm run strava:learn), darker the more often, beneath
// the route. Offered only where the map service has them.
export function useRidesLayer(map: ShallowRef<Map | null>) {
  const available = ref(false);
  const shown = ref((() => { try { return localStorage.getItem(shownKey) === '1'; } catch { return false; } })());
  let tiles: { tiles: string[]; minzoom: number; maxzoom: number } | undefined;
  void fetch('/maps/rides.json').then(async response => {
    if (!response.ok) return;
    tiles = await response.json();
    available.value = true;
  }).catch(() => { /* Without the map service there are no rides to show. */ });

  function apply() {
    const instance = map.value;
    if (!instance || !tiles || !instance.getLayer('basemap-overlay-anchor')) return;
    if (!instance.getSource('rides')) {
      instance.addSource('rides', { type: 'vector', tiles: tiles.tiles.map(absoluteUrl), minzoom: tiles.minzoom, maxzoom: tiles.maxzoom });
      const rides: ExpressionSpecification = ['ln', ['get', 'rides']];
      instance.addLayer({ id: 'rides', type: 'line', source: 'rides', 'source-layer': 'rides',
        layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'rides'] },
        paint: {
          'line-color': ['interpolate', ['linear'], rides, 0, ridesStyle.once, most / 2, ridesStyle.often, most, ridesStyle.most],
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, ['interpolate', ['linear'], rides, 0, 1.2, most, 2.4],
            14, ['interpolate', ['linear'], rides, 0, 2, most, 5]],
          'line-opacity': .85,
        } }, 'basemap-overlay-anchor');
    }
    instance.setLayoutProperty('rides', 'visibility', shown.value ? 'visible' : 'none');
  }
  watch([map, available], () => {
    const instance = map.value;
    if (instance?.getLayer('basemap-overlay-anchor')) apply();
    else instance?.once('style.load', apply);
  });
  watch(shown, () => {
    apply();
    try { localStorage.setItem(shownKey, shown.value ? '1' : '0'); } catch { /* Storage may be disabled. */ }
  });
  return { rides: shown, ridesAvailable: available };
}

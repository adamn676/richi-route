import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { Map, NavigationControl } from 'maplibre-gl';
import { basemapSources, initialBasemap } from '@/config/basemaps';

export function useMap(container: string) {
  const map = shallowRef<Map | null>(null);
  const basemap = ref(initialBasemap());
  const mapError = ref('');
  function applyBasemap() {
    if (!map.value?.getLayer('street')) return;
    for (const [id, visible] of [
      ['street', basemap.value === 'street'], ['aerial', basemap.value === 'aerial'],
      ['labels', basemap.value === 'aerial'], ['roads', basemap.value === 'local'],
    ] as const) map.value.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
  watch(basemap, () => {
    mapError.value = '';
    applyBasemap();
    try { localStorage.setItem('richiroute.review-basemap', basemap.value); } catch { /* Storage may be disabled. */ }
  });
  onMounted(() => {
    const instance = new Map({
      container, center: [15.4395, 47.0707], zoom: 13,
      style: {
        version: 8,
        sources: {
          ...basemapSources,
          roads: { type: 'vector', tiles: [`${location.origin}/tiles/{z}/{x}/{y}.mvt`], maxzoom: 16, attribution: '© OpenStreetMap contributors' },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#e9ede7' } },
          ...(['street', 'aerial', 'labels'] as const).map(id => ({
            id, type: 'raster' as const, source: `basemap-${id}`,
            layout: { visibility: (id === 'street' ? basemap.value === 'street' : basemap.value === 'aerial') ? 'visible' as const : 'none' as const },
          })),
          { id: 'roads', type: 'line', source: 'roads', 'source-layer': 'roads',
            layout: { visibility: basemap.value === 'local' ? 'visible' : 'none' },
            paint: { 'line-color': '#9eaaa0', 'line-width': 2 } },
        ],
      },
    });
    instance.addControl(new NavigationControl(), 'bottom-right');
    instance.on('error', () => {
      mapError.value = basemap.value === 'local'
        ? 'Lokale Karte nicht erreichbar. Routing-Engines mit npm run bench:up starten.'
        : 'Kartenbilder nicht erreichbar. Internetverbindung prüfen oder lokale Karte wählen.';
    });
    instance.on('load', applyBasemap);
    map.value = instance;
  });
  onBeforeUnmount(() => map.value?.remove());
  return { map, basemap, mapError };
}

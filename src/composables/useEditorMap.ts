import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { AttributionControl, Map, NavigationControl, ScaleControl, setMaxParallelImageRequests, type LineLayerSpecification, type RasterTileSource, type StyleSpecification } from 'maplibre-gl';
import { aerialVectorLayers, cyclingMapLayer, cyclingRoadPaint, fastImagerySource, imagerySource, imageryOverviewSource, initialBasemap, vectorBasemapUrl } from '@/config/basemaps';
import { MAP_LABELS_ANCHOR } from '@/config/map.config';
import { onlineBasemap } from '@/config/online-basemaps';
import { createOnlineBasemaps } from './onlineBasemaps';

export function useMap(container: string) {
  const map = shallowRef<Map | null>(null);
  const basemap = ref(initialBasemap());
  const mapError = ref('');
  const aerialMap = () => basemap.value === 'aerial' || basemap.value === 'aerial-fast';
  const vectorLayers: { id: string; visibility: 'visible' | 'none'; localContext: boolean }[] = [];
  const aerialLayers: string[] = [];
  type RoadColor = NonNullable<LineLayerSpecification['paint']>['line-color'];
  const roadColors: { id: string; original: RoadColor; cycling: RoadColor }[] = [];
  const fullVectorMap = () => ['street', 'cycling', 'terrain'].includes(basemap.value);
  let onlineMaps: ReturnType<typeof createOnlineBasemaps> | undefined;
  let attribution = new AttributionControl();
  let onlineAttribution = false;
  let vectorReady = false, vectorFailed = false;
  let vectorRequest: AbortController | undefined;
  const absoluteUrl = (url: string) => url.startsWith('/') ? location.origin + url : url;
  async function loadVectorMap() {
    const instance = map.value;
    if (!instance || vectorReady || vectorFailed || vectorRequest) return;
    const request = new AbortController();
    vectorRequest = request;
    try {
      const response = await fetch(vectorBasemapUrl, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) });
      if (!response.ok) throw new Error(`Map style: HTTP ${response.status}`);
      const style: StyleSpecification = await response.json();
      request.signal.throwIfAborted();
      onlineMaps?.setLocalStyle(style);
      for (const [id, source] of Object.entries(style.sources)) {
        instance.addSource(`basemap-vector-${id}`, source.type === 'vector'
          ? { ...source, tiles: source.tiles?.map(absoluteUrl) } : source);
      }
      for (const layer of style.layers) {
        const id = `basemap-vector-${layer.id}`;
        const visibility = layer.layout?.visibility === 'none' ? 'none' : 'visible';
        const roadLabel = layer.id.startsWith('roads_labels_');
        const localContext = roadLabel || ('source-layer' in layer && layer['source-layer'] === 'places') || ['water', 'water_river'].includes(layer.id);
        const visible = fullVectorMap() || basemap.value === 'local' && localContext;
        instance.addLayer({ ...layer, id, ...('source' in layer ? { source: `basemap-vector-${layer.source}` } : {}),
          layout: { ...layer.layout, visibility: visible ? visibility : 'none' } }, roadLabel ? 'map-labels-top' : 'aerial');
        vectorLayers.push({ id, visibility, localContext });
        if (layer.type === 'line') {
          const paint = cyclingRoadPaint(layer);
          if (paint) roadColors.push({ id, original: layer.paint?.['line-color'], cycling: paint['line-color'] });
        }
      }
      instance.addLayer({ ...cyclingMapLayer, layout: { ...cyclingMapLayer.layout, visibility: 'none' } }, 'basemap-overlay-anchor');
      for (const layer of aerialVectorLayers(style)) {
        instance.addLayer({ ...layer, layout: { ...layer.layout, visibility: aerialMap() ? 'visible' : 'none' } },
          layer.type === 'symbol' ? 'map-labels-top' : 'basemap-overlay-anchor');
        aerialLayers.push(layer.id);
      }
      instance.addLayer({ id: 'roads', type: 'line', source: 'basemap-vector-europe', 'source-layer': 'roads',
        layout: { visibility: basemap.value === 'local' ? 'visible' : 'none' },
        paint: {
          'line-color': ['match', ['get', 'kind'], 'highway', '#b08e56', 'major_road', '#77887c',
            'minor_road', '#9ba89b', '#c0c7bb'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, .6, 12, 1, 16, 2, 20, 3],
        } }, 'basemap-overlay-anchor');
      vectorReady = true;
    } catch {
      if (request.signal.aborted) return;
      vectorFailed = true;
      mapError.value = 'Lokale Straßenkarte nicht erreichbar. Kartendienst starten und erneut laden.';
    } finally {
      if (vectorRequest === request) { vectorRequest = undefined; applyBasemap(); }
    }
  }
  function applyBasemap() {
    if (!map.value?.getLayer('aerial')) return;
    // Slow regional exports must not fill the browser queue ahead of local labels.
    setMaxParallelImageRequests(basemap.value === 'aerial' ? 8 : 32);
    for (const layer of vectorLayers) {
      const visible = fullVectorMap() || basemap.value === 'local' && layer.localContext;
      map.value.setLayoutProperty(layer.id, 'visibility', visible && vectorReady ? layer.visibility : 'none');
    }
    for (const road of roadColors) map.value.setPaintProperty(road.id, 'line-color', basemap.value === 'cycling' ? road.cycling : road.original);
    if (basemap.value === 'terrain' && vectorReady && !map.value.getSource('basemap-terrain')) {
      map.value.addSource('basemap-terrain', { type: 'raster-dem', url: '/maps/terrain.json', tileSize: 512, encoding: 'terrarium' });
      const roads = vectorLayers.find(layer => layer.id.startsWith('basemap-vector-roads_tunnels_'));
      map.value.addLayer({ id: 'basemap-hillshade', type: 'hillshade', source: 'basemap-terrain',
        paint: { 'hillshade-exaggeration': .45, 'hillshade-shadow-color': '#445648',
          'hillshade-highlight-color': '#fffcec', 'hillshade-accent-color': '#68765b' } }, roads?.id ?? 'aerial');
    }
    for (const id of aerialLayers) map.value.setLayoutProperty(id, 'visibility', aerialMap() && vectorReady ? 'visible' : 'none');
    for (const [id, visible] of [
      ['imagery-overview', aerialMap()], ['aerial', basemap.value === 'aerial'], ['roads', basemap.value === 'local'],
      ['aerial-fast', basemap.value === 'aerial-fast'],
      ['basemap-cycling-paths', basemap.value === 'cycling'], ['basemap-hillshade', basemap.value === 'terrain'],
    ] as const) if (map.value.getLayer(id)) map.value.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    const online = onlineBasemap(basemap.value);
    if (onlineAttribution !== Boolean(online)) {
      map.value.removeControl(attribution);
      attribution = new AttributionControl(online ? { compact: false } : {});
      map.value.addControl(attribution);
      onlineAttribution = Boolean(online);
    }
    void onlineMaps?.show(online?.id);
    void loadVectorMap();
  }
  function retryBasemap() {
    mapError.value = '';
    vectorFailed = false;
    if (vectorReady) map.value?.refreshTiles('basemap-vector-europe');
    else void loadVectorMap();
    if (aerialMap()) {
      for (const [id, source] of [['basemap-aerial', imagerySource], ['basemap-aerial-fast', fastImagerySource], ['basemap-imagery-overview', imageryOverviewSource]] as const) {
        if (source.url) map.value?.getSource<RasterTileSource>(id)?.setUrl(source.url);
      }
    }
    if (basemap.value === 'terrain') map.value?.getSource<RasterTileSource>('basemap-terrain')?.setUrl('/maps/terrain.json');
    const online = onlineBasemap(basemap.value);
    if (online) void onlineMaps?.show(online.id, true);
  }
  watch(basemap, () => {
    mapError.value = '';
    vectorFailed = false;
    applyBasemap();
    try { localStorage.setItem('richiroute.review-basemap', basemap.value); } catch { /* Storage may be disabled. */ }
  });
  onMounted(() => {
    const instance = new Map({
      container, center: [15.4395, 47.0707], zoom: 13, maxZoom: 21, fadeDuration: 100, attributionControl: false,
      style: {
        version: 8,
        sources: {
          'basemap-imagery-overview': imageryOverviewSource,
          // Tile size is in CSS pixels; retain image detail on dense screens.
          'basemap-aerial': { ...imagerySource, tileSize: 256 / Math.min(2, Math.max(1, window.devicePixelRatio)) },
          'basemap-aerial-fast': { ...fastImagerySource, tileSize: 256 / Math.min(2, Math.max(1, window.devicePixelRatio)) },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#f3f4f1' } },
          { id: 'imagery-overview', type: 'raster', source: 'basemap-imagery-overview',
            layout: { visibility: aerialMap() ? 'visible' : 'none' } },
          { id: 'aerial', type: 'raster', source: 'basemap-aerial',
            minzoom: 9,
            paint: { 'raster-fade-duration': 100 },
            layout: { visibility: basemap.value === 'aerial' ? 'visible' : 'none' } },
          { id: 'aerial-fast', type: 'raster', source: 'basemap-aerial-fast', minzoom: 9,
            paint: { 'raster-fade-duration': 100 },
            layout: { visibility: basemap.value === 'aerial-fast' ? 'visible' : 'none' } },
          { id: 'basemap-overlay-anchor', type: 'background', paint: { 'background-opacity': 0 } },
          { id: MAP_LABELS_ANCHOR, type: 'background', paint: { 'background-opacity': 0 } },
          { id: 'map-labels-top', type: 'background', paint: { 'background-opacity': 0 } },
        ],
      },
    });
    instance.addControl(new NavigationControl(), 'bottom-right');
    instance.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    instance.addControl(attribution);
    instance.on('error', event => {
      const online = onlineBasemap(basemap.value);
      if (online) {
        mapError.value = `${online.label} ist nicht erreichbar. Erneut laden oder eine lokale Karte wählen.`;
        return;
      }
      if ('sourceId' in event && event.sourceId === 'basemap-terrain') {
        mapError.value = 'Geländedaten nicht erreichbar. Geländedaten installieren und Kartendienst neu starten.';
        return;
      }
      mapError.value = aerialMap()
        ? 'Luftbild oder Beschriftungen nicht erreichbar. Die Straßenkarte ist lokal verfügbar.'
        : 'Lokale Straßenkarte nicht erreichbar. Kartendienst prüfen.';
    });
    onlineMaps = createOnlineBasemaps(instance, message => { mapError.value = message; });
    instance.on('style.load', applyBasemap);
    map.value = instance;
  });
  onBeforeUnmount(() => { vectorRequest?.abort(); vectorRequest = undefined; onlineMaps?.close(); map.value?.remove(); });
  return { map, basemap, mapError, retryBasemap };
}

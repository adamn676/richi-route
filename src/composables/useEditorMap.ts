import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { AttributionControl, Map, ScaleControl, setMaxParallelImageRequests, type LayerSpecification, type RasterTileSource, type StyleSpecification } from 'maplibre-gl';
import { aerialVectorLayers, imagerySource, imageryOverviewSource, initialBasemap, vectorBasemapUrl } from '@/config/basemaps';
import { MAP_BOUNDS, MAP_LABELS_ANCHOR } from '@/config/map.config';
import { onlineBasemap, onlineBasemaps } from '@/config/online-basemaps';
import { setSearchFocus } from '@/services/geocoding.service';

const hillshadeKey = 'richiroute.hillshade';

export function useMap(container: string, creditsContainer: string) {
  const map = shallowRef<Map | null>(null);
  const basemap = ref(initialBasemap());
  // Terrain shading from the local terrain data, on unless switched off; satellite photos have real shadows, so it stays
  // off there.
  const hillshade = ref((() => { try { return localStorage.getItem(hillshadeKey) !== '0'; } catch { return true; } })());
  const mapError = ref('');
  const aerialMap = () => basemap.value === 'aerial';
  const vectorMap = () => basemap.value === 'street';
  const vectorLayers: { id: string; visibility: 'visible' | 'none' }[] = [];
  const aerialLayers: string[] = [];
  // Credits for the visible map, shown in the sidebar footer instead of over the map. The route and
  // its surfaces come from OpenStreetMap, so it is credited on every basemap; MapLibre drops this
  // entry where a basemap's credit contains the same text.
  const attribution = new AttributionControl({ compact: false,
    customAttribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
  let creditsOutside = false;
  // The providers' credits link away; as every link out of the planner, they open in a new tab, whoever wrote them.
  const creditLinks = new MutationObserver(records => {
    for (const { target } of records) for (const link of (target as Element).querySelectorAll('a')) Object.assign(link, { target: '_blank', rel: 'noopener noreferrer' });
  });
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
      if (style.glyphs) instance.setGlyphs(absoluteUrl(style.glyphs));
      if (typeof style.sprite === 'string') instance.setSprite(absoluteUrl(style.sprite));
      for (const [id, source] of Object.entries(style.sources)) {
        instance.addSource(`basemap-vector-${id}`, source.type === 'vector'
          ? { ...source, tiles: source.tiles?.map(absoluteUrl) } : source);
      }
      for (const layer of style.layers) {
        const id = `basemap-vector-${layer.id}`;
        const visibility = layer.layout?.visibility === 'none' ? 'none' : 'visible';
        instance.addLayer({ ...layer, id, ...('source' in layer ? { source: `basemap-vector-${layer.source}` } : {}),
          layout: { ...layer.layout, visibility: vectorMap() ? visibility : 'none' } }, layer.id.startsWith('roads_labels_') ? 'map-labels-top' : 'aerial');
        vectorLayers.push({ id, visibility });
      }
      for (const layer of aerialVectorLayers(style)) {
        instance.addLayer({ ...layer, layout: { ...layer.layout, visibility: aerialMap() ? 'visible' : 'none' } },
          layer.type === 'symbol' ? 'map-labels-top' : 'basemap-overlay-anchor');
        aerialLayers.push(layer.id);
      }
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
    const instance = map.value;
    if (!instance?.getLayer('aerial')) return;
    // Slow regional exports must not fill the browser queue ahead of local labels.
    setMaxParallelImageRequests(aerialMap() ? 8 : 32);
    for (const layer of vectorLayers) instance.setLayoutProperty(layer.id, 'visibility', vectorMap() && vectorReady ? layer.visibility : 'none');
    for (const id of aerialLayers) instance.setLayoutProperty(id, 'visibility', aerialMap() && vectorReady ? 'visible' : 'none');
    if (hillshade.value && !instance.getSource('basemap-terrain')) {
      instance.addSource('basemap-terrain', { type: 'raster-dem', url: '/maps/terrain.json', tileSize: 512, encoding: 'terrarium' });
      instance.addLayer({ id: 'basemap-hillshade', type: 'hillshade', source: 'basemap-terrain',
        // Soft, and softer still in town, where the coarse terrain data would only smudge streets and buildings.
        paint: { 'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 12, .25, 16, .08], 'hillshade-shadow-color': '#5d6a63',
          'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#7b8a80' } }, 'basemap-overlay-anchor');
    }
    // On Karte the shading lies beneath the roads; on online maps it lies over them.
    if (instance.getLayer('basemap-hillshade')) {
      const roads = vectorMap() && vectorLayers.find(layer => layer.id.startsWith('basemap-vector-roads_tunnels_'));
      instance.moveLayer('basemap-hillshade', roads ? roads.id : 'basemap-overlay-anchor');
    }
    const visibility: [string, boolean][] = [['imagery-overview', aerialMap()], ['aerial', aerialMap()], ['basemap-hillshade', hillshade.value && !aerialMap()],
      ...onlineBasemaps.map(item => [`online-${item.id}`, basemap.value === item.id] as [string, boolean])];
    for (const [id, visible] of visibility) if (instance.getLayer(id)) instance.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    void loadVectorMap();
  }
  function retryBasemap() {
    mapError.value = '';
    vectorFailed = false;
    if (vectorReady) map.value?.refreshTiles('basemap-vector-europe');
    else void loadVectorMap();
    if (aerialMap()) {
      for (const [id, source] of [['basemap-aerial', imagerySource], ['basemap-imagery-overview', imageryOverviewSource]] as const) {
        if (source.url) map.value?.getSource<RasterTileSource>(id)?.setUrl(source.url);
      }
    }
    if (hillshade.value) map.value?.getSource<RasterTileSource>('basemap-terrain')?.setUrl('/maps/terrain.json');
    const online = onlineBasemap(basemap.value);
    if (online) map.value?.refreshTiles(`online-${online.id}`);
  }
  watch(basemap, () => {
    mapError.value = '';
    vectorFailed = false;
    applyBasemap();
    try { localStorage.setItem('richiroute.review-basemap', basemap.value); } catch { /* Storage may be disabled. */ }
  });
  watch(hillshade, () => {
    applyBasemap();
    try { localStorage.setItem(hillshadeKey, hillshade.value ? '1' : '0'); } catch { /* Storage may be disabled. */ }
  });
  onMounted(() => {
    const instance = new Map({
      container, center: [15.4395, 47.0707], zoom: 13, maxZoom: 21, maxBounds: MAP_BOUNDS, renderWorldCopies: false,
      fadeDuration: 100, attributionControl: false,
      style: {
        version: 8,
        sources: {
          ...Object.fromEntries(onlineBasemaps.map(item => [`online-${item.id}`, item.source])),
          'basemap-imagery-overview': imageryOverviewSource,
          // Tile size is in CSS pixels; retain image detail on dense screens.
          'basemap-aerial': { ...imagerySource, tileSize: 256 / Math.min(2, Math.max(1, window.devicePixelRatio)) },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#f3f4f1' } },
          { id: 'imagery-overview', type: 'raster', source: 'basemap-imagery-overview',
            layout: { visibility: aerialMap() ? 'visible' : 'none' } },
          ...onlineBasemaps.map((item): LayerSpecification => ({ id: `online-${item.id}`, type: 'raster', source: `online-${item.id}`,
            layout: { visibility: basemap.value === item.id ? 'visible' : 'none' }, paint: { 'raster-fade-duration': 100 } })),
          // Detail starts where the local overview gets too coarse to stretch, so long routes stay sharp.
          { id: 'aerial', type: 'raster', source: 'basemap-aerial',
            minzoom: 7,
            paint: { 'raster-fade-duration': 100 },
            layout: { visibility: basemap.value === 'aerial' ? 'visible' : 'none' } },
          { id: 'basemap-overlay-anchor', type: 'background', paint: { 'background-opacity': 0 } },
          { id: MAP_LABELS_ANCHOR, type: 'background', paint: { 'background-opacity': 0 } },
          { id: 'map-labels-top', type: 'background', paint: { 'background-opacity': 0 } },
        ],
      },
    });
    // A panel moving one of the map's edges leaves the map's content where it is; MapLibre itself keeps the centre.
    let frame = instance.getContainer().getBoundingClientRect();
    instance.on('resize', () => {
      const next = instance.getContainer().getBoundingClientRect();
      const dx = next.left + next.width / 2 - (frame.left + frame.width / 2), dy = next.top + next.height / 2 - (frame.top + frame.height / 2);
      frame = next;
      if ((dx || dy) && !instance.isMoving()) instance.panBy([dx, dy], { animate: false });
    });
    instance.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    // Address search prefers places near where the map looks.
    const reportCenter = () => { const { lng, lat } = instance.getCenter(); setSearchFocus([lng, lat]); };
    reportCenter();
    instance.on('moveend', reportCenter);
    const credits = document.getElementById(creditsContainer);
    if (credits) {
      creditLinks.observe(credits, { childList: true, subtree: true });
      credits.append(attribution.onAdd(instance));
    } else instance.addControl(attribution);
    creditsOutside = Boolean(credits);
    instance.on('error', event => {
      const sourceId = 'sourceId' in event && typeof event.sourceId === 'string' ? event.sourceId : '';
      // Rad-Infos reports problems with its own sources.
      if (sourceId.startsWith('cycling-')) return;
      if (sourceId === 'basemap-terrain') {
        mapError.value = 'Geländedaten nicht erreichbar. Geländedaten installieren und Kartendienst neu starten.';
        return;
      }
      const online = onlineBasemap(basemap.value);
      if (online) {
        mapError.value = `${online.label} ist nicht erreichbar. Erneut laden oder eine lokale Karte wählen.`;
        return;
      }
      mapError.value = aerialMap()
        ? 'Satellitenbild oder Beschriftungen nicht erreichbar. Die Straßenkarte ist lokal verfügbar.'
        : 'Lokale Straßenkarte nicht erreichbar. Kartendienst prüfen.';
    });
    instance.on('style.load', applyBasemap);
    map.value = instance;
  });
  onBeforeUnmount(() => {
    creditLinks.disconnect();
    vectorRequest?.abort(); vectorRequest = undefined;
    if (creditsOutside) attribution.onRemove();
    map.value?.remove();
  });
  return { map, basemap, hillshade, mapError, retryBasemap };
}

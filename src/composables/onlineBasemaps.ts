import type { Map, StyleSpecification } from 'maplibre-gl';
import { onlineBasemap, osmStandardStyle, type OnlineBasemap } from '@/config/online-basemaps';

export function createOnlineBasemaps(map: Map, reportError: (message: string) => void) {
  const styles = new globalThis.Map<OnlineBasemap, StyleSpecification>();
  let selected: OnlineBasemap | undefined;
  let request: AbortController | undefined;
  let layerIds: string[] = [];
  let localStyle: StyleSpecification | undefined;
  let glyphs: string | undefined;
  let sprite: StyleSpecification['sprite'];
  const absolute = (url: string) => url.startsWith('/') ? location.origin + url : url;

  function assets(style?: StyleSpecification, retry = false) {
    const nextGlyphs = style?.glyphs ?? localStyle?.glyphs;
    const nextSprite = style?.sprite ?? localStyle?.sprite;
    if (glyphs !== nextGlyphs || retry) {
      map.setGlyphs(nextGlyphs ? absolute(nextGlyphs) : undefined);
      glyphs = nextGlyphs;
    }
    if ((sprite !== nextSprite || retry) && typeof nextSprite === 'string') {
      map.setSprite(absolute(nextSprite)); sprite = nextSprite;
    }
  }
  async function show(id?: OnlineBasemap, retry = false) {
    if (id === selected && !retry) return;
    selected = id;
    request?.abort(); request = undefined;
    for (const layer of layerIds) map.removeLayer(layer);
    layerIds = [];
    if (!id) { assets(); return; }
    const definition = onlineBasemap(id)!;
    const controller = new AbortController(); request = controller;
    try {
      let style = styles.get(id);
      if (!style) {
        if ('style' in definition) {
          const response = await fetch(definition.style, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          style = await response.json() as StyleSpecification;
        } else style = osmStandardStyle;
        styles.set(id, style);
      }
      controller.signal.throwIfAborted();
      assets(style, retry);
      for (const [name, source] of Object.entries(style.sources)) {
        const sourceId = `online-${definition.provider}-${name}`;
        if (retry && map.getSource(sourceId)) map.removeSource(sourceId);
        if (!map.getSource(sourceId)) map.addSource(sourceId, source);
      }
      for (const layer of style.layers) {
        const layerId = `online-${id}-${layer.id}`;
        map.addLayer({ ...layer, id: layerId,
          ...('source' in layer ? { source: `online-${definition.provider}-${layer.source}` } : {}),
        }, layer.type === 'symbol' ? 'map-labels-top' : 'aerial');
        layerIds.push(layerId);
      }
    } catch {
      if (!controller.signal.aborted) reportError(`${definition.label} ist nicht erreichbar. Erneut laden oder eine lokale Karte wählen.`);
    } finally { if (request === controller) request = undefined; }
  }
  function setLocalStyle(style: StyleSpecification) {
    localStyle = style;
    assets(selected && styles.get(selected));
  }
  return { show, setLocalStyle, close: () => request?.abort() };
}

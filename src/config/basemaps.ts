import type { LayerSpecification, LineLayerSpecification, RasterSourceSpecification, StyleSpecification } from 'maplibre-gl';
import { onlineBasemap, type OnlineBasemap } from './online-basemaps';

export type EditorBasemap = 'street' | 'aerial' | OnlineBasemap;
export const vectorBasemapUrl = '/maps/style.json';
export const imagerySource: RasterSourceSpecification = { type: 'raster', url: '/maps/imagery.json', tileSize: 256 };
export const imageryOverviewSource: RasterSourceSpecification = {
  type: 'raster', url: '/maps/imagery-overview.json', tileSize: 256,
};
export const localBasemaps: { id: Exclude<EditorBasemap, OnlineBasemap>; label: string }[] = [
  { id: 'street', label: 'Karte' }, { id: 'aerial', label: 'Satellit' },
];

// WMTS templates verified against basemap.at's EPSG:3857 capabilities.
function raster(layer: string, extension: string): RasterSourceSpecification {
  return {
    type: 'raster',
    tiles: [`https://mapsneu.wien.gv.at/basemap/${layer}/normal/google3857/{z}/{y}/{x}.${extension}`],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 20,
    bounds: [8.782379, 46.358770, 17.5, 49.037872],
    attribution: 'Grundkarte: <a href="https://basemap.at/" target="_blank" rel="noopener">basemap.at</a>',
  };
}

export const basemapSources = {
  'basemap-street': raster('bmapgrau', 'png'),
  'basemap-aerial': raster('bmaporthofoto30cm', 'jpeg'),
  'basemap-labels': raster('bmapoverlay', 'png'),
};

export function aerialVectorLayers(style: StyleSpecification): LayerSpecification[] {
  const road = style.layers.find(layer => layer.type === 'line' && layer['source-layer'] === 'roads');
  const layers: LayerSpecification[] = [];
  if (road && 'source' in road) {
    for (const casing of [true, false]) layers.push({
      id: `basemap-hybrid-road${casing ? '-casing' : ''}`,
      type: 'line', source: `basemap-vector-${road.source}`, 'source-layer': 'roads', minzoom: 12,
      filter: ['all', ['==', ['geometry-type'], 'LineString'],
        ['match', ['get', 'kind'], ['highway', 'major_road', 'minor_road'], true, false]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': casing ? '#14291e' : '#f7f5e8',
        'line-opacity': casing ? .35 : .6,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, casing ? 1.5 : .5, 16, casing ? 3 : 1.2, 20, casing ? 4 : 2],
      },
    });
    layers.push({
      id: 'basemap-hybrid-path', type: 'line', source: `basemap-vector-${road.source}`,
      'source-layer': 'roads', minzoom: 15,
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'kind'], 'path']],
      paint: { 'line-color': '#e2e9ce', 'line-opacity': .6, 'line-width': 1, 'line-dasharray': [2, 2] },
    });
  }
  for (const layer of style.layers) {
    if (layer.type !== 'symbol' || !layer.layout?.['text-field']) continue;
    const sourceLayer = layer['source-layer'];
    if (sourceLayer !== 'places' && sourceLayer !== 'water' && !layer.id.startsWith('roads_labels_')) continue;
    layers.push({
      ...layer, id: `basemap-hybrid-${layer.id}`, source: `basemap-vector-${layer.source}`,
      ...(layer.id === 'places_locality' ? { maxzoom: 14 } : {}),
      layout: { ...layer.layout, 'icon-image': '' },
      paint: { ...layer.paint, 'text-color': '#ffffff', 'text-halo-color': '#172a22',
        'text-halo-width': 1.6, 'text-halo-blur': .5 },
    });
  }
  return layers;
}

// Motorways recede and minor roads stand out, as suits cycling.
export function cyclingRoadPaint(layer: LineLayerSpecification): LineLayerSpecification['paint'] {
  if (layer['source-layer'] !== 'roads') return undefined;
  if (layer.id.includes('highway')) return { 'line-color': layer.id.includes('casing') ? '#b9bbb3' : '#dddcd3' };
  if (layer.id.includes('minor') && layer.id.includes('casing')) return { 'line-color': '#738f81' };
  if (layer.id.includes('major') && layer.id.includes('casing')) return { 'line-color': '#b7a581' };
  return undefined;
}

export function initialBasemap(): EditorBasemap {
  try {
    const value = localStorage.getItem('richiroute.review-basemap');
    const online = value && onlineBasemap(value);
    if (online) return online.id;
    // The former fast satellite view is now part of Satellit; former map variants and online styles fall back to Karte.
    return localBasemaps.find(item => item.id === (value === 'aerial-fast' ? 'aerial' : value))?.id ?? 'street';
  } catch { return 'street'; }
}

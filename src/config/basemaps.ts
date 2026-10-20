import type { RasterSourceSpecification } from 'maplibre-gl';

export type Basemap = 'street' | 'aerial' | 'local';
export const basemapOptions: { id: Basemap; label: string }[] = [
  { id: 'street', label: 'Street map' },
  { id: 'aerial', label: 'Aerial + labels' },
  { id: 'local', label: 'Local roads' },
];

// WMTS templates verified against basemap.at's EPSG:3857 capabilities.
function raster(layer: string, extension: string): RasterSourceSpecification {
  return {
    type: 'raster',
    tiles: [`https://maps.wien.gv.at/basemap/${layer}/normal/google3857/{z}/{y}/{x}.${extension}`],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 19,
    bounds: [9.4, 46.3, 17.2, 49.1],
    attribution: 'Grundkarte: <a href="https://basemap.at/" target="_blank" rel="noopener">basemap.at</a>',
  };
}

export const basemapSources = {
  'basemap-street': raster('geolandbasemap', 'png'),
  'basemap-aerial': raster('bmaporthofoto30cm', 'jpeg'),
  'basemap-labels': raster('bmapoverlay', 'png'),
};

export function initialBasemap(): Basemap {
  try {
    const value = localStorage.getItem('richiroute.review-basemap');
    return value === 'local' || value === 'aerial' ? value : 'street';
  } catch { return 'street'; }
}

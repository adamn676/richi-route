import type { RasterSourceSpecification } from 'maplibre-gl';

// OpenTopoMap adds what the local map lacks: contour lines, peaks and field tracks. Its volunteer server allows
// moderate use with a clearly visible credit. CyclOSM is left out: its host serves only public non-profit sites.
export type OnlineBasemap = 'opentopomap';
export const onlineBasemaps: { id: OnlineBasemap; label: string; source: RasterSourceSpecification }[] = [
  { id: 'opentopomap', label: 'OpenTopoMap · Gelände', source: {
    type: 'raster', tiles: ['a', 'b', 'c'].map(server => `https://${server}.tile.opentopomap.org/{z}/{x}/{y}.png`),
    tileSize: 256, maxzoom: 17,
    attribution: 'Kartendarstellung: © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) · SRTM',
  } },
];
export const onlineBasemap = (id: string) => onlineBasemaps.find(item => item.id === id);

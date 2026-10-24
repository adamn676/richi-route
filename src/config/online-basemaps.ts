import type { StyleSpecification } from 'maplibre-gl';

export const onlineBasemaps = [
  { id: 'osm', label: 'OpenStreetMap Standard', provider: 'osm' },
  { id: 'liberty', label: 'OpenFreeMap Liberty', provider: 'openfreemap',
    style: 'https://tiles.openfreemap.org/styles/liberty' },
  { id: 'bright', label: 'OpenFreeMap Bright', provider: 'openfreemap',
    style: 'https://tiles.openfreemap.org/styles/bright' },
  { id: 'positron', label: 'OpenFreeMap Positron', provider: 'openfreemap',
    style: 'https://tiles.openfreemap.org/styles/positron' },
  { id: 'dark', label: 'OpenFreeMap Dark', provider: 'openfreemap',
    style: 'https://tiles.openfreemap.org/styles/dark' },
] as const;

export type OnlineBasemap = typeof onlineBasemaps[number]['id'];
export const onlineBasemap = (id: string) => onlineBasemaps.find(item => item.id === id);

export const osmStandardStyle: StyleSpecification = {
  version: 8,
  sources: { standard: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    tileSize: 256, maxzoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  } },
  layers: [{ id: 'standard', type: 'raster', source: 'standard', paint: { 'raster-fade-duration': 100 } }],
};

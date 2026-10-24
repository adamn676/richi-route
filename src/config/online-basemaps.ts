import type { StyleSpecification } from 'maplibre-gl';

export const onlineBasemaps = [
  { id: 'osm', label: 'OpenStreetMap Standard', provider: 'osm',
    description: 'Die klassische OpenStreetMap-Karte. Internet erforderlich.' },
  { id: 'liberty', label: 'OpenFreeMap Liberty', provider: 'openfreemap',
    description: 'Detaillierte OSM-Vektorkarte mit klaren Straßenklassen. Internet erforderlich.',
    style: 'https://tiles.openfreemap.org/styles/liberty' },
  { id: 'bright', label: 'OpenFreeMap Bright', provider: 'openfreemap',
    description: 'Kontrastreiche Straßen und Orientierungspunkte. Internet erforderlich.',
    style: 'https://tiles.openfreemap.org/styles/bright' },
  { id: 'positron', label: 'OpenFreeMap Positron', provider: 'openfreemap',
    description: 'Ruhige, helle Karte, auf der die Route im Vordergrund steht. Internet erforderlich.',
    style: 'https://tiles.openfreemap.org/styles/positron' },
  { id: 'dark', label: 'OpenFreeMap Dark', provider: 'openfreemap',
    description: 'Dunkle Karte für die Planung am Abend. Internet erforderlich.',
    style: 'https://tiles.openfreemap.org/styles/dark' },
] as const;

export type OnlineBasemap = typeof onlineBasemaps[number]['id'];
export const onlineBasemap = (id: string) => onlineBasemaps.find(item => item.id === id);

export const osmStandardStyle: StyleSpecification = {
  version: 8,
  sources: { standard: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    tileSize: 256, maxzoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  } },
  layers: [{ id: 'standard', type: 'raster', source: 'standard', paint: { 'raster-fade-duration': 100 } }],
};

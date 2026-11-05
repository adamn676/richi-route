// The planner's street map (Protomaps layers), as scripts/start-maps.mjs serves it and scripts/build-ios-map.mjs
// writes it for the iPhone app.
import { layers, namedFlavor } from '@protomaps/basemaps';

export const mapAttribution = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>';
export const terrainAttribution = 'Relief: <a href="https://mapterhorn.com/attribution/">Mapterhorn · Datenquellen</a>';
// A calm light map, so the route, cycle paths and points stand out: off-white land, soft greens, white minor roads with
// light outlines, pale main roads, and motorways, which bicycles may not use, in grey.
const light = { ...namedFlavor('light'),
  background: '#f4f4f1', earth: '#f4f4f1', water: '#a8d2e6', buildings: '#e2e0da',
  park_a: '#e1eed5', park_b: '#d2e7bf', wood_a: '#d9eacb', wood_b: '#c4dfb0',
  scrub_a: '#e4edd6', scrub_b: '#d6e6c4', industrial: '#ebebe7', pedestrian: '#efede6', hospital: '#efe8e7', school: '#efece5',
  minor_a: '#ffffff', minor_b: '#ffffff', minor_service: '#ffffff', other: '#bdb7aa', railway: '#b9bfbd',
  minor_casing: '#c3c8c1', minor_service_casing: '#d3d7d0', bridges_minor_casing: '#c3c8c1',
  major: '#fdf5e1', link: '#fdf5e1', major_casing_early: '#c9c1ad', major_casing_late: '#c9c1ad', link_casing: '#c9c1ad',
  bridges_major: '#fdf5e1', bridges_link: '#fdf5e1', bridges_major_casing: '#c9c1ad', bridges_link_casing: '#c9c1ad',
  highway: '#e4e1da', highway_casing_early: '#c6c2b8', highway_casing_late: '#c6c2b8',
  bridges_highway: '#e4e1da', bridges_highway_casing: '#c6c2b8',
  landcover: { ...namedFlavor('light').landcover, forest: '#c9e2b8', grassland: '#e6eed8',
    farmland: '#f1f0e6', urban_area: '#ecece8', scrub: '#d6e6c4' },
  roads_label_minor: '#5f6762', roads_label_major: '#4b524e',
  subplace_label: '#757c77', subplace_label_halo: '#f4f4f1',
  city_label: '#2f3834', city_label_halo: '#f4f4f1',
  state_label: '#7a817c', country_label: '#5c645f', ocean_label: '#4f7f95',
  building_outline: '#d4d1ca', boundaries: '#a9aea9',
};
// The same map at night (the iPhone in Dark Mode): charcoal land, dark greens and blue, grey roads with warmer main roads,
// light labels.
const dark = { ...namedFlavor('dark'),
  background: '#1e2221', earth: '#1e2221', water: '#1d3442', buildings: '#2b2f2e',
  park_a: '#1f2a23', park_b: '#223225', wood_a: '#1f2a22', wood_b: '#233325',
  scrub_a: '#212922', scrub_b: '#243026', industrial: '#232726', pedestrian: '#262a29', hospital: '#2a2627', school: '#28272a',
  minor_a: '#3a3f3e', minor_b: '#3a3f3e', minor_service: '#343938', other: '#4a4f4c', railway: '#4b5250',
  minor_casing: '#2a2e2d', minor_service_casing: '#262a29', bridges_minor_casing: '#2a2e2d',
  major: '#4d4a42', link: '#4d4a42', major_casing_early: '#2a2e2d', major_casing_late: '#2a2e2d', link_casing: '#2a2e2d',
  bridges_major: '#4d4a42', bridges_link: '#4d4a42', bridges_major_casing: '#2a2e2d', bridges_link_casing: '#2a2e2d',
  highway: '#404342', highway_casing_early: '#2a2e2d', highway_casing_late: '#2a2e2d',
  bridges_highway: '#404342', bridges_highway_casing: '#2a2e2d',
  landcover: { ...namedFlavor('dark').landcover, forest: '#1f2e24', grassland: '#222a22',
    farmland: '#232724', urban_area: '#252928', scrub: '#243026' },
  roads_label_minor: '#9aa29e', roads_label_minor_halo: '#1e2221', roads_label_major: '#b4bbb7', roads_label_major_halo: '#1e2221',
  subplace_label: '#9aa19c', subplace_label_halo: '#1e2221',
  city_label: '#dfe5e1', city_label_halo: '#1e2221',
  state_label: '#8a918c', state_label_halo: '#1e2221', country_label: '#a7aea9', ocean_label: '#7fa7bb',
  address_label: '#8a918c', address_label_halo: '#1e2221',
  building_outline: '#343837', boundaries: '#5c625f',
};
export const mapLayers = (source, night = false) => { const flavor = night ? dark : light;
  return layers(source, flavor, { lang: 'de' }).flatMap(layer => {
  if (layer.id === 'pois') return [{ ...layer, minzoom: 16 }];
  if (layer.id === 'buildings') return [{ ...layer, paint: { ...layer.paint,
    'fill-opacity': 1, 'fill-outline-color': flavor.building_outline } }];
  if (layer.id === 'landuse_park') return [{ ...layer, paint: { ...layer.paint,
    'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6, .25, 9, 1] } }];
  // Borders in the place names' ink, dashed as maps mark them: countries growing with the zoom, so that they read in
  // the overview; regions lighter and thinner.
  if (layer.id === 'boundaries_country') return [{ ...layer, layout: { ...layer.layout, 'line-join': 'round' }, paint: { ...layer.paint,
    'line-color': flavor.country_label, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, .9, 8, 1.3, 12, 1.6], 'line-dasharray': [4, 2] } }];
  if (layer.id === 'boundaries') return [{ ...layer, paint: { ...layer.paint,
    'line-color': flavor.boundaries, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, .5, 10, .8] } }];
  return [layer];
}); };

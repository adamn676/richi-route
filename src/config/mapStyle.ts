import type { HillshadeLayerSpecification } from 'maplibre-gl';

// The relief: soft, and softer still in town, where the coarse terrain data would only smudge streets and buildings.
export const hillshadePaint = {
  'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 12, .25, 16, .08], 'hillshade-shadow-color': '#5d6a63',
  'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#7b8a80',
} satisfies HillshadeLayerSpecification['paint'];

export const routeStyle = {
  outlineColor: '#ffffff',
  // Paved to unpaved, told apart also with colour-blindness; unknown stays a light grey that recedes.
  paved: '#0b7d58',
  // A lighter paved: probably the same, less certain.
  likelyPaved: '#5fb393',
  rough: '#ec9a12',
  unpaved: '#d63384',
  unknown: '#a7b0b8',
  // A straight leg: red when it failed, the panel's ink while it is being calculated.
  air: '#b33c4b',
  waiting: '#4d5753',
};

// Richi Fahrten: the roads ridden, violet from once to a hundred times and more, apart from the route's and the loops'
// colours.
export const ridesStyle = { once: '#ad8ddc', often: '#8255c8', most: '#4f1f8f' };

// Suggested loops, told apart on the map and in their cards by lightness as well as hue, so also with colour-blindness;
// none is a surface colour, which the chosen loop then shows.
export const loopColors = ['#2f5fd0', '#1c2421', '#38a3dd'] as const;

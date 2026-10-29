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

// Suggested loops, told apart on the map and in their cards by lightness as well as hue, so also with colour-blindness;
// none is a surface colour, which the chosen loop then shows.
export const loopColors = ['#2f5fd0', '#1c2421', '#38a3dd'] as const;

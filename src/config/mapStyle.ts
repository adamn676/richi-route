export const routeStyle = {
  outlineColor: '#ffffff',
  // Smooth to rough, told apart also with colour-blindness; unknown stays a light grey that recedes.
  asphalt: '#0b7d58',
  // A lighter asphalt: probably the same, less certain.
  likelyAsphalt: '#5fb393',
  paved: '#3a86f0',
  rough: '#ec9a12',
  unpaved: '#d63384',
  unknown: '#a7b0b8',
  air: '#b33c4b',
};

// Suggested loops, told apart on the map and in their cards (checked for colour-blind separation).
export const loopColors = ['#2f5fd0', '#d9480f', '#8e3fb8'] as const;

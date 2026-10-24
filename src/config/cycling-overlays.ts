export const cyclingOverlays = [
  { id: 'water', label: 'Trinkwasser', color: '#087bb4', minzoom: 12 },
  { id: 'cycleways', label: 'Radwege', color: '#00a9b0', minzoom: 12 },
  { id: 'repair', label: 'Reparatur & Radläden', color: '#755539', minzoom: 12 },
  { id: 'food', label: 'Verpflegung', color: '#a35d12', minzoom: 14 },
  { id: 'stations', label: 'Bahnhöfe', color: '#526477', minzoom: 12 },
] as const;
export type CyclingOverlay = typeof cyclingOverlays[number]['id'];
export const cyclingPoiLayers = cyclingOverlays.filter(item => item.id !== 'cycleways')
  .flatMap(item => [`cycling-${item.id}`, `cycling-${item.id}-labels`]);
// A small area around a click or tap, so points smaller than a fingertip are still easy to hit.
export const poiHitBox = ({ x, y }: { x: number; y: number }): [[number, number], [number, number]] => [[x - 8, y - 8], [x + 8, y + 8]];

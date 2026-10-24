export const cyclingOverlays = [
  { id: 'water', label: 'Trinkwasser', color: '#087bb4', hint: 'Als Trinkwasser erfasste Brunnen und Quellen', minzoom: 12 },
  { id: 'cycleways', label: 'Radwege', color: '#386bd1', hint: 'Separat kartierte Radwege, keine vollständige Radspurkarte', minzoom: 12 },
  { id: 'repair', label: 'Reparatur & Radläden', color: '#755539', hint: 'Reparaturstationen und Fahrradgeschäfte', minzoom: 12 },
  { id: 'food', label: 'Verpflegung', color: '#a35d12', hint: 'Supermärkte, Bäckereien und Cafés', minzoom: 14 },
  { id: 'stations', label: 'Bahnhöfe', color: '#526477', hint: 'Bahnstationen; Fahrradmitnahme beim Betreiber prüfen', minzoom: 12 },
] as const;
export type CyclingOverlay = typeof cyclingOverlays[number]['id'];
export const cyclingPoiLayers = cyclingOverlays.filter(item => item.id !== 'cycleways')
  .flatMap(item => [`cycling-${item.id}`, `cycling-${item.id}-labels`]);

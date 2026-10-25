import type { Map } from 'maplibre-gl';

// Fits the map now and again once its size settles within a second, as panels appear or the phone sheet makes way.
export function fitAndSettle(map: Map, fit: () => void) {
  fit();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = () => { clearTimeout(timer); timer = setTimeout(fit, 100); };
  map.on('resize', settle);
  setTimeout(() => map.off('resize', settle), 1000);
}

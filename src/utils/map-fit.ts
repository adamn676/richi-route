import { LngLatBounds, type Map } from 'maplibre-gl';
import type { Coord } from '@/domain/route-model';

const padding = { top: 60, bottom: 60, left: 60, right: 120 };
const fit = (map: Map, bounds: LngLatBounds) => map.fitBounds(bounds, { padding, maxZoom: 16, duration: 1000 });
// The stretch each map was last asked to show, and when.
const shown = new WeakMap<Map, { bounds: LngLatBounds; at: number }>();

// Every move the planner makes: the same one-second glide, however far (a maxDuration would turn longer flights into
// jumps), clear of the map's buttons on the right; MapLibre leaves the motion out where reduced motion is asked for.
// When the map changes size within a second (a panel appearing, the phone sheet making way), the latest stretch is
// shown again.
export function showOnMap(map: Map, ...lines: Coord[][]) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const line of lines) for (const coord of line) {
    west = Math.min(west, coord[0]); east = Math.max(east, coord[0]);
    south = Math.min(south, coord[1]); north = Math.max(north, coord[1]);
  }
  if (west > east) return;
  if (!shown.has(map)) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    map.on('resize', () => {
      if (performance.now() - shown.get(map)!.at > 1000) return;
      clearTimeout(timer);
      timer = setTimeout(() => fit(map, shown.get(map)!.bounds), 100);
    });
  }
  const bounds = new LngLatBounds([west, south], [east, north]);
  shown.set(map, { bounds, at: performance.now() });
  fit(map, bounds);
}

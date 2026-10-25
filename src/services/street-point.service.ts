import type { Coord } from '../domain/route-model.ts';

const kx = (lat: number) => 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;

// The nearest point on these lines within a distance, in local metres around the point.
export function nearestOnLines([lon, lat]: Coord, lines: Coord[][], maxMeters: number): Coord | null {
  const x = kx(lat);
  let best: Coord | null = null, bestMeters = maxMeters;
  for (const line of lines) for (let i = 1; i < line.length; i++) {
    const ax = (line[i - 1][0] - lon) * x, ay = (line[i - 1][1] - lat) * ky, bx = (line[i][0] - lon) * x, by = (line[i][1] - lat) * ky;
    const t = Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2 || 1)));
    const px = ax + t * (bx - ax), py = ay + t * (by - ay), meters = Math.hypot(px, py);
    if (meters <= bestMeters) { bestMeters = meters; best = [lon + px / x, lat + py / ky]; }
  }
  return best;
}

// The point on an address's own street nearest to it, from the planner's map tiles. A house's centre can lie nearer a
// path behind it (a park, a yard) than its street, and snapping alone would start the route there. Null when the
// street is not within 150 m or the tiles are unavailable.
export async function pointOnStreet(coord: Coord, street: string, signal: AbortSignal): Promise<Coord | null> {
  const [{ VectorTile }, { PbfReader }] = await Promise.all([import('@mapbox/vector-tile'), import('pbf')]);
  // The tiles within 150 m, at the tiles' most detailed zoom.
  const z = 14, n = 2 ** z, dLon = 150 / kx(coord[1]), dLat = 150 / ky;
  const tileX = (lon: number) => Math.floor((lon + 180) / 360 * n);
  const tileY = (lat: number) => Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  const xs = new Set([tileX(coord[0] - dLon), tileX(coord[0] + dLon)]), ys = new Set([tileY(coord[1] + dLat), tileY(coord[1] - dLat)]);
  const name = street.toLocaleLowerCase('de-AT'), lines: Coord[][] = [];
  for (const x of xs) for (const y of ys) {
    const response = await fetch(`/maps/tiles/${z}/${x}/${y}.mvt`, { signal });
    if (!response.ok) continue;
    const roads = new VectorTile(new PbfReader(new Uint8Array(await response.arrayBuffer()))).layers.roads;
    for (let i = 0; i < (roads?.length ?? 0); i++) {
      const feature = roads.feature(i);
      if (String(feature.properties.name ?? '').toLocaleLowerCase('de-AT') !== name) continue;
      const geometry = feature.toGeoJSON(x, y, z).geometry;
      if (geometry.type === 'LineString') lines.push(geometry.coordinates as Coord[]);
      else if (geometry.type === 'MultiLineString') lines.push(...geometry.coordinates as Coord[][]);
    }
  }
  return nearestOnLines(coord, lines, 150);
}

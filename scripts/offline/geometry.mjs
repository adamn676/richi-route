// What routing and the address search cover (search/src/build.rs ROUTING_AREA; the engine's segment tiles), as
// [west, south, east, north].
export const routingArea = [5, 45, 20, 50];
export const inRoutingArea = ([lon, lat]) => lon >= routingArea[0] && lon <= routingArea[2] && lat >= routingArea[1] && lat <= routingArea[3];

// Whether a point lies inside a ring of [lon, lat] points (even-odd rule).
export function inside([x, y], ring) {
  let within = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) within = !within;
  }
  return within;
}

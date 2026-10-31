// Whether a point lies inside a ring of [lon, lat] points (even-odd rule).
export function inside([x, y], ring) {
  let within = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) within = !within;
  }
  return within;
}

const MAX_TILES = 4000;
const LATITUDE_LIMIT = 85.05112878;
export function tilePoint(lon, lat, z) {
  const scale = 2 ** z, radians = Math.max(-LATITUDE_LIMIT, Math.min(LATITUDE_LIMIT, lat)) * Math.PI / 180;
  return [(lon + 180) / 360 * scale, (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * scale];
}
export function regionTiles(bounds, maxzoom, tracks, bufferKm = 1) {
  if (!Number.isInteger(maxzoom) || maxzoom < 9 || maxzoom > 20) throw new Error('maxzoom must be between 9 and 20.');
  if (!(bufferKm > 0 && bufferKm <= 10)) throw new Error('buffer-km must be between 0 and 10.');
  if (bounds.length !== 4 || !bounds.every(Number.isFinite)
    || bounds[0] < -25 || bounds[1] < 34 || bounds[2] > 45 || bounds[3] > 72
    || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new Error('Select an area within European coverage: -25,34,45,72.');
  const tiles = new Map();
  function add(z, x, y) {
    tiles.set(`${z}/${x}/${y}`, [z, x, y]);
    if (tiles.size > MAX_TILES) throw new Error(`Selection exceeds ${MAX_TILES} tiles. Use a smaller area or lower maxzoom.`);
  }
  for (let z = 9; z <= maxzoom; z++) {
    if (!tracks) {
      const [left, bottom] = tilePoint(bounds[0], bounds[1], z);
      const [right, top] = tilePoint(bounds[2], bounds[3], z);
      for (let x = Math.floor(left); x < Math.ceil(right); x++) {
        for (let y = Math.floor(top); y < Math.ceil(bottom); y++) add(z, x, y);
      }
      continue;
    }
    const radius = bufferKm * 1000 / (40075016.686 / 2 ** z * Math.cos(bounds[3] * Math.PI / 180));
    const margin = radius + Math.SQRT1_2 + .25;
    for (const track of tracks) {
      for (let i = 0; i < track.length; i++) {
        const a = tilePoint(...track[Math.max(0, i - 1)], z), b = tilePoint(...track[i], z);
        const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2));
        if (steps > MAX_TILES * 2) throw new Error('Route is too long for this zoom level. Lower maxzoom.');
        for (let step = 0; step <= steps; step++) {
          const px = a[0] + (b[0] - a[0]) * step / steps, py = a[1] + (b[1] - a[1]) * step / steps;
          for (let x = Math.floor(px - margin); x <= Math.floor(px + margin); x++) {
            for (let y = Math.floor(py - margin); y <= Math.floor(py + margin); y++) {
              if (Math.hypot(x + .5 - px, y + .5 - py) <= margin) add(z, x, y);
            }
          }
        }
      }
    }
  }
  return [...tiles.values()];
}

import { position } from './compare.mjs';
import { kept } from './rides.mjs';

// Counts a ride's road sections (trace-rides.mjs) into `counts`: each section, either way, once per ride.
export function countRide(counts, sections) {
  const taken = new Set(sections.map(section => {
    const [lon1, lat1, lon2, lat2] = section.split(',');
    const [a, b] = [`${lon1},${lat1}`, `${lon2},${lat2}`];
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }));
  for (const key of taken) counts.set(key, (counts.get(key) ?? 0) + 1);
}

// The roads a rider took, as lines for a map: the sections counted by `countRide`, joined into lines between junctions
// and where the number of rides changes.
export function roadLines(counts) {
  const neighbours = new Map();
  for (const key of counts.keys()) {
    for (const [from, to] of [key.split('|'), key.split('|').reverse()]) {
      if (!neighbours.has(from)) neighbours.set(from, []);
      neighbours.get(from).push(to);
    }
  }
  const edge = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
  const used = new Set(), lines = [];
  // The points beyond `to`, coming from `from`, while the line goes on unbranched with the same rides.
  const onwards = (from, to, rides) => {
    const points = [];
    for (let previous = from, at = to; ;) {
      const next = neighbours.get(at);
      if (next.length !== 2) return points;
      const following = next[0] === previous ? next[1] : next[0], key = edge(at, following);
      if (used.has(key) || counts.get(key) !== rides) return points;
      used.add(key);
      points.push(following);
      [previous, at] = [at, following];
    }
  };
  for (const [key, rides] of counts) {
    if (used.has(key)) continue;
    used.add(key);
    const [a, b] = key.split('|');
    const points = [...onwards(b, a, rides).reverse(), a, b, ...onwards(a, b, rides)];
    lines.push({ rides, points: points.map(position) });
  }
  return lines;
}

// The lines in the tiles of zoom `z`: tile key "x/y" → rides → lines in tile units of `extent`, simplified to about half
// a screen pixel and cut at the tile's edge plus `buffer`.
export function tileLines(lines, z, extent = 4096, buffer = 64) {
  const scale = 2 ** z * extent;
  const project = ([lon, lat]) => {
    const sin = Math.sin(lat * Math.PI / 180);
    return [(lon + 180) / 360 * scale, (.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale];
  };
  const tiles = new Map();
  for (const { rides, points } of lines) {
    const all = points.map(project), keep = kept(all, extent / 1024);
    const xy = all.filter((_, i) => keep[i]);
    const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
    for (let x = Math.floor((Math.min(...xs) - buffer) / extent); x <= Math.floor((Math.max(...xs) + buffer) / extent); x++) {
      for (let y = Math.floor((Math.min(...ys) - buffer) / extent); y <= Math.floor((Math.max(...ys) + buffer) / extent); y++) {
        const parts = clip(xy, x * extent - buffer, y * extent - buffer, (x + 1) * extent + buffer, (y + 1) * extent + buffer)
          .map(part => part.map(([px, py]) => [Math.round(px - x * extent), Math.round(py - y * extent)]))
          .map(part => part.filter((p, i) => i === 0 || p[0] !== part[i - 1][0] || p[1] !== part[i - 1][1]))
          .filter(part => part.length > 1);
        if (!parts.length) continue;
        const key = `${x}/${y}`;
        if (!tiles.has(key)) tiles.set(key, new Map());
        const byRides = tiles.get(key);
        if (!byRides.has(rides)) byRides.set(rides, []);
        byRides.get(rides).push(...parts);
      }
    }
  }
  return tiles;
}

// The parts of a line inside a rectangle (Liang–Barsky on each segment).
function clip(xy, minX, minY, maxX, maxY) {
  const parts = [];
  let part = null;
  for (let i = 1; i < xy.length; i++) {
    const [[x1, y1], [x2, y2]] = [xy[i - 1], xy[i]], dx = x2 - x1, dy = y2 - y1;
    let t0 = 0, t1 = 1;
    for (const [p, q] of [[-dx, x1 - minX], [dx, maxX - x1], [-dy, y1 - minY], [dy, maxY - y1]]) {
      if (p === 0) { if (q < 0) { t0 = 1; t1 = 0; } continue; }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    if (t0 > t1) { part = null; continue; }
    const start = [x1 + t0 * dx, y1 + t0 * dy], end = [x1 + t1 * dx, y1 + t1 * dy];
    if (!part || t0 > 0) { part = [start]; parts.push(part); }
    part.push(end);
    if (t1 < 1) part = null;
  }
  return parts;
}

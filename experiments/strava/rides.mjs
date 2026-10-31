import { gunzipSync } from 'node:zlib';
import { decodeGpx, parseGpx } from '../../src/domain/gpx-import.ts';
import { fitPositions } from './fit.mjs';

// activities.csv of a Strava archive, as rows of fields (quoted fields may hold commas, quotes and line breaks).
export function csvRows(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

// The activities ridden outdoors on a road bike: rides ("Radfahrt", not virtual ones) whose bike isn't a mountain bike.
export function roadRides(text) {
  const [header, ...rows] = csvRows(text);
  const column = name => header.indexOf(name);
  const [id, date, name, type, gear, file] = ['Aktivitäts-ID', 'Aktivitätsdatum', 'Name der Aktivität', 'Aktivitätsart',
    'Aktivitätsausrüstung', 'Dateiname'].map(column);
  return rows.filter(row => row[type] === 'Radfahrt' && row[gear]?.trim() && !/\bMTB\b/i.test(row[gear]) && row[file])
    .map(row => ({ id: row[id], date: row[date], name: row[name], gear: row[gear], file: row[file] }));
}

// The positions of an activity file as exported: FIT or GPX, either gzipped.
export function filePositions(fileName, bytes) {
  if (fileName.endsWith('.gz')) return filePositions(fileName.slice(0, -3), gunzipSync(bytes));
  if (fileName.endsWith('.fit')) return fitPositions(bytes);
  if (fileName.endsWith('.gpx')) {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return parseGpx(decodeGpx(buffer), fileName).segments.flatMap(segment => segment.coordinates);
  }
  if (fileName.endsWith('.tcx')) {
    return [...new TextDecoder().decode(bytes).matchAll(/<Position>\s*<LatitudeDegrees>([-\d.]+)<\/LatitudeDegrees>\s*<LongitudeDegrees>([-\d.]+)</g)]
      .map(([, lat, lon]) => [Number(lon), Number(lat)]);
  }
  throw new Error(`Unknown activity file ${fileName}`);
}

// Drops the points a track keeps within `tolerance` metres without (Douglas–Peucker), in metres on a local plane.
export function simplify(points, tolerance = 5) {
  if (points.length < 3) return points;
  const scale = 111_320 * Math.cos(points[0][1] * Math.PI / 180);
  const xy = points.map(([lon, lat]) => [lon * scale, lat * 110_574]);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  for (const stack = [[0, points.length - 1]]; stack.length;) {
    const [first, last] = stack.pop();
    const [ax, ay] = xy[first], dx = xy[last][0] - ax, dy = xy[last][1] - ay, length = dx * dx + dy * dy;
    let farthest = -1, distance = tolerance;
    for (let i = first + 1; i < last; i++) {
      const t = length ? Math.max(0, Math.min(1, ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / length)) : 0;
      const d = Math.hypot(xy[i][0] - ax - t * dx, xy[i][1] - ay - t * dy);
      if (d > distance) { distance = d; farthest = i; }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    stack.push([first, farthest], [farthest, last]);
  }
  return points.filter((_, i) => keep[i]);
}

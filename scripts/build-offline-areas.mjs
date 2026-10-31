// Builds public/offline-areas.json: the outlines of the areas in scripts/offline-areas.json, from their OpenStreetMap
// boundaries (© OpenStreetMap contributors, ODbL), simplified for a map of all of them.
//   node scripts/build-offline-areas.mjs [--update]
// The boundaries are fetched once from Overpass into .cache/offline/boundaries/; --update fetches them again.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import catalogue from './offline-areas.json' with { type: 'json' };
import { inside, routingArea } from './offline/geometry.mjs';

const { areas } = catalogue;

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, '.cache/offline/boundaries');
const target = path.join(root, 'public/offline-areas.json');
// Room for error at the scale of the map of all areas, where a pixel is a kilometre or more.
const toleranceMeters = 250;
// Islands and enclaves smaller than this are left out.
const smallestRing = 2e6;
// Areas are cut to the routing area; one with less than a third of itself inside is left out.
const smallestShare = 1 / 3;

async function exists(file) {
  try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// One boundary per request: Overpass gives up on all of them at once.
async function fetchBoundary(code) {
  const query = code.includes('-')
    ? `[out:json][timeout:300];relation["boundary"="administrative"]["admin_level"~"^(4|6)$"]["ISO3166-2"="${code}"];out geom;`
    : `[out:json][timeout:300];relation["boundary"="administrative"]["admin_level"="2"]["ISO3166-1"="${code}"];out geom;`;
  for (let attempt = 1; ; attempt++) {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', body: new URLSearchParams({ data: query }), headers: { 'User-Agent': 'richi-route offline areas build' },
    });
    if (response.ok) return response.text();
    if (attempt === 4 || ![429, 502, 503, 504].includes(response.status)) throw new Error(`Overpass, ${code}: HTTP ${response.status}`);
    await new Promise(resolve => setTimeout(resolve, attempt * 20_000));
  }
}
const codes = [...new Set(areas.flatMap(area => area.boundaries))];
await mkdir(cache, { recursive: true });
const relations = new Map();
for (const code of codes) {
  const file = path.join(cache, `${code}.json`);
  if (process.argv.includes('--update') || !await exists(file)) {
    console.log(`Fetching ${code}`);
    await writeFile(file, await fetchBoundary(code));
  }
  const { elements } = JSON.parse(await readFile(file, 'utf8'));
  if (elements.length !== 1) throw new Error(`${elements.length} boundaries for ${code}`);
  relations.set(code, elements[0]);
}

// Distances in metres on a plane through the routing area's middle.
const xScale = 111320 * Math.cos(47 * Math.PI / 180), yScale = 110540;
function offset([x, y], [ax, ay], [bx, by]) {
  const px = (x - ax) * xScale, py = (y - ay) * yScale, dx = (bx - ax) * xScale, dy = (by - ay) * yScale, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, (px * dx + py * dy) / length)) : 0;
  return Math.hypot(px - t * dx, py - t * dy);
}
function simplify(line) {
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop();
    let farthest = -1, distance = toleranceMeters;
    for (let i = from + 1; i < to; i++) {
      const d = offset(line[i], line[from], line[to]);
      if (d > distance) { distance = d; farthest = i; }
    }
    if (farthest >= 0) { keep[farthest] = 1; stack.push([from, farthest], [farthest, to]); }
  }
  return line.filter((_, i) => keep[i]);
}

// Each way is simplified once, its ends kept, so two areas sharing a border draw the same line.
const ways = new Map();
function wayLine(member) {
  if (!ways.has(member.ref)) ways.set(member.ref, simplify(member.geometry.map(point => [point.lon, point.lat])));
  return ways.get(member.ref);
}

const key = ([x, y]) => `${x},${y}`;
// The ways' lines joined end to end into closed rings.
function rings(lines, area) {
  const byEnd = new Map(), used = new Set(), result = [];
  lines.forEach((line, i) => [line[0], line.at(-1)].forEach(end => byEnd.set(key(end), [...byEnd.get(key(end)) ?? [], i])));
  lines.forEach((first, start) => {
    if (used.has(start)) return;
    used.add(start);
    const ring = [...first];
    while (key(ring[0]) !== key(ring.at(-1))) {
      const next = byEnd.get(key(ring.at(-1)))?.find(i => !used.has(i));
      if (next === undefined) throw new Error(`${area.name}: the boundary does not close at ${key(ring.at(-1))}`);
      used.add(next);
      const line = key(lines[next][0]) === key(ring.at(-1)) ? lines[next] : [...lines[next]].reverse();
      ring.push(...line.slice(1));
    }
    result.push(ring);
  });
  return result;
}
function squareMeters(ring) {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) sum += (ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1]);
  return sum / 2 * xScale * yScale;
}
// Rings inside an odd number of others are holes; each hole goes to the smallest ring around it.
function polygons(found) {
  const rings = found.filter(ring => Math.abs(squareMeters(ring)) >= smallestRing);
  const probe = ring => ring.slice(0, 2).reduce((a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  const around = rings.map(ring => rings.filter(other => other !== ring && inside(probe(ring), other)));
  const outers = rings.filter((_, i) => around[i].length % 2 === 0).map(ring => [squareMeters(ring) > 0 ? ring : [...ring].reverse()]);
  rings.forEach((ring, i) => {
    if (around[i].length % 2 === 0) return;
    const parent = around[i].filter(other => around[rings.indexOf(other)].length % 2 === 0)
      .sort((a, b) => Math.abs(squareMeters(a)) - Math.abs(squareMeters(b)))[0];
    outers.find(polygon => polygon[0] === parent || polygon[0].toString() === [...parent].reverse().toString())
      .push(squareMeters(ring) < 0 ? ring : [...ring].reverse());
  });
  return outers;
}

// The ring's part inside the routing area (Sutherland–Hodgman, one side at a time), or nothing.
function clip(ring) {
  const [west, south, east, north] = routingArea;
  const sides = [[p => p[0] >= west, (a, b) => [west, a[1] + (b[1] - a[1]) * (west - a[0]) / (b[0] - a[0])]],
    [p => p[0] <= east, (a, b) => [east, a[1] + (b[1] - a[1]) * (east - a[0]) / (b[0] - a[0])]],
    [p => p[1] >= south, (a, b) => [a[0] + (b[0] - a[0]) * (south - a[1]) / (b[1] - a[1]), south]],
    [p => p[1] <= north, (a, b) => [a[0] + (b[0] - a[0]) * (north - a[1]) / (b[1] - a[1]), north]]];
  let points = ring.slice(0, -1);
  for (const [within, cross] of sides) {
    const kept = [];
    points.forEach((point, i) => {
      const previous = points.at(i - 1);
      if (within(point) !== within(previous)) kept.push(cross(previous, point));
      if (within(point)) kept.push(point);
    });
    points = kept;
  }
  return points.length >= 3 ? [...points, points[0]] : null;
}
const netArea = found => polygons(found).flat().reduce((sum, ring) => sum + squareMeters(ring), 0);

const round = value => Math.round(value * 1e4) / 1e4;
// Where an area's name goes: the point of its largest part farthest from the border, found on a grid and refined
// around the best point twice.
function labelPoint(polygons) {
  const [outer, ...holes] = polygons.reduce((a, b) => Math.abs(squareMeters(b[0])) > Math.abs(squareMeters(a[0])) ? b : a);
  const rings = [outer, ...holes];
  const clearance = point => {
    if (!inside(point, outer) || holes.some(hole => inside(point, hole))) return -1;
    return Math.min(...rings.flatMap(ring => ring.slice(1).map((end, i) => offset(point, ring[i], end))));
  };
  let [west, south, east, north] = [Math.min(...outer.map(p => p[0])), Math.min(...outer.map(p => p[1])),
    Math.max(...outer.map(p => p[0])), Math.max(...outer.map(p => p[1]))];
  let best = outer[0], bestClearance = -1;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i <= 24; i++) {
      for (let j = 0; j <= 24; j++) {
        const point = [west + (east - west) * i / 24, south + (north - south) * j / 24], value = clearance(point);
        if (value > bestClearance) [best, bestClearance] = [point, value];
      }
    }
    const [dx, dy] = [(east - west) / 12, (north - south) / 12];
    [west, south, east, north] = [best[0] - dx, best[1] - dy, best[0] + dx, best[1] + dy];
  }
  return best.map(round);
}
const left = [];
const features = areas.flatMap(area => {
  // Borders between the boundaries an area is made of appear twice and fall away.
  const counts = new Map();
  for (const code of area.boundaries) {
    for (const member of relations.get(code).members) {
      if (member.type !== 'way' || !['outer', 'inner', ''].includes(member.role)) continue;
      counts.set(member.ref, (counts.get(member.ref) ?? { member, count: 0 }));
      counts.get(member.ref).count++;
    }
  }
  const lines = [...counts.values()].filter(({ count }) => count % 2).map(({ member }) => wayLine(member));
  const whole = rings(lines, area), within = whole.map(clip).filter(Boolean);
  if (netArea(within) < netArea(whole) * smallestShare) { left.push(area.name); return []; }
  const coordinates = polygons(within).map(polygon => polygon.map(ring => ring.map(([x, y]) => [round(x), round(y)])));
  return { type: 'Feature', properties: { id: area.id, name: area.name, country: area.country, label: labelPoint(coordinates) },
    geometry: { type: 'MultiPolygon', coordinates } };
});
const json = JSON.stringify({ type: 'FeatureCollection', attribution: '© OpenStreetMap contributors (ODbL)', features });
await writeFile(target, json + '\n');
const points = features.reduce((sum, feature) => sum + feature.geometry.coordinates.flat(2).length, 0);
if (left.length) console.log(`Outside the routing area: ${left.join(', ')}`);
console.log(`${features.length} areas, ${points} points, ${(json.length / 1024).toFixed(0)} KB: ${path.relative(root, target)}`);

// How a planned route compares with the rider's own track: rides cut into legs, and the share of each line that lies
// on the other.
const radius = 6_371_008.8, rad = Math.PI / 180;
// Metres on a plane around a latitude; good for the few kilometres of a leg.
const plane = latitude => ([lon, lat]) => [lon * rad * radius * Math.cos(latitude * rad), lat * rad * radius];
const length = points => points.reduce((sum, point, i) => i ? sum + Math.hypot(point[0] - points[i - 1][0], point[1] - points[i - 1][1]) : 0, 0);

export const legMeters = 10_000;
// A leg that comes back towards its start (a turn, a café stop off the way) says nothing about the road between its ends.
const directLeg = .5;

// A ride's legs of about `legMeters`, the last one taking the rest; each leg a slice of the ride's points.
export function legs(points, every = legMeters) {
  const xy = points.map(plane(points[0][1]));
  const cuts = [0];
  for (let i = 1, done = 0; i < xy.length; i++) {
    done += Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
    if (done >= every * cuts.length) cuts.push(i);
  }
  if (cuts.at(-1) !== xy.length - 1) {
    const rest = length(xy.slice(cuts.at(-1)));
    if (rest < every / 2 && cuts.length > 1) cuts.pop();
    cuts.push(xy.length - 1);
  }
  return cuts.slice(1).map((end, i) => points.slice(cuts[i], end + 1))
    .filter(leg => {
      const legXy = leg.map(plane(leg[0][1]));
      return Math.hypot(legXy.at(-1)[0] - legXy[0][0], legXy.at(-1)[1] - legXy[0][1]) >= directLeg * length(legXy);
    });
}

// The share of line `a`'s length within `tolerance` metres of any of `lines` (a route, or the road sections of a ride),
// measured every few metres along `a`.
export function shareOn(a, lines, tolerance = 20) {
  const toXy = plane(a[0][1]), ax = a.map(toXy);
  const cell = 100, grid = new Map();
  for (const line of lines) {
    const xy = line.map(toXy);
    for (let i = 1; i < xy.length; i++) {
      const [p, q] = [xy[i - 1], xy[i]];
      for (let x = Math.floor((Math.min(p[0], q[0]) - tolerance) / cell); x <= Math.floor((Math.max(p[0], q[0]) + tolerance) / cell); x++) {
        for (let y = Math.floor((Math.min(p[1], q[1]) - tolerance) / cell); y <= Math.floor((Math.max(p[1], q[1]) + tolerance) / cell); y++) {
          const key = `${x},${y}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push([p, q]);
        }
      }
    }
  }
  const near = ([x, y]) => (grid.get(`${Math.floor(x / cell)},${Math.floor(y / cell)}`) ?? []).some(([p, q]) => {
    const dx = q[0] - p[0], dy = q[1] - p[1], squared = dx * dx + dy * dy;
    const t = squared ? Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / squared)) : 0;
    return Math.hypot(x - p[0] - t * dx, y - p[1] - t * dy) <= tolerance;
  });
  let total = 0, matched = 0;
  for (let i = 1; i < ax.length; i++) {
    const [p, q] = [ax[i - 1], ax[i]], meters = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const steps = Math.max(1, Math.ceil(meters / 5));
    for (let s = 0; s < steps; s++) {
      const t = (s + .5) / steps;
      if (near([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])])) matched += meters / steps;
    }
    total += meters;
  }
  return { meters: total, share: total ? Math.min(1, matched / total) : 1 };
}

// Rides fall into five fixed groups by their id. Group 0 is kept out of all learning, for the final check; while tuning,
// group 1 is learned without and measured.
export const group = id => Number(BigInt(id) % 5n);

// Positions as the engine writes them (millionths of a degree from 180° W and 90° S), in degrees: a "lon,lat" position,
// and a road section from `sections` as a line.
const degrees = ([lon, lat]) => [lon / 1e6 - 180, lat / 1e6 - 90];
export const position = text => degrees(text.split(',').map(Number));
export const sectionLine = section => { const values = section.split(',').map(Number); return [degrees(values.slice(0, 2)), degrees(values.slice(2))]; };

// The directed road sections of a route, as "lon1,lat1,lon2,lat2" in the engine's integer positions. A route through
// several points (`vias`) has extra points where it reached them: on a road between two of the map's points, or at the
// tip of a spur out and back. Within 50 m of a via such points go; so do the first and last sections, which start and
// end wherever the route's ends snapped to.
export function sections(coordinates, vias = []) {
  const cell = ([lon, lat]) => `${Math.floor(lon * 1000)},${Math.floor(lat * 1000)}`;
  const viaCells = new Map();
  for (const via of vias) { const key = cell(via); if (!viaCells.has(key)) viaCells.set(key, []); viaCells.get(key).push(via); }
  const metres = ([lon1, lat1], [lon2, lat2]) => [(lon2 - lon1) * 111_320 * Math.cos(lat1 * rad), (lat2 - lat1) * 110_574];
  const nearVia = point => [-.001, 0, .001].some(dx => [-.001, 0, .001].some(dy =>
    (viaCells.get(cell([point[0] + dx, point[1] + dy])) ?? []).some(via => Math.hypot(...metres(point, via)) < 50)));
  // Whether `point` lies on the straight line from `a` to `b`, between them, as a point the route snapped to does.
  const between = (a, point, b) => {
    const [x, y] = metres(a, b), [px, py] = metres(a, point), squared = x * x + y * y;
    const t = squared && (px * x + py * y) / squared;
    return t > 0 && t < 1 && Math.abs(px * y - py * x) / Math.sqrt(squared) < .3;
  };
  const rounded = coordinates.map(([lon, lat]) => [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]);
  const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
  const points = [];
  for (const point of rounded) {
    for (let last = points.at(-1), before = points.at(-2); before && !same(point, last) && nearVia(last); last = points.at(-1), before = points.at(-2)) {
      if (!same(point, before) && !between(before, last, point)) break;
      points.pop();
    }
    if (!same(point, points.at(-1))) points.push(point);
  }
  return points.slice(1, -2).map((point, i) => `${positionKey(point)},${positionKey(points[i + 2])}`);
}
// A position as the engine writes it.
export const positionKey = ([lon, lat]) => `${Math.round(lon * 1e6) + 180_000_000},${Math.round(lat * 1e6) + 90_000_000}`;

// How many rides passed through the area of each point, about 2 km across; a leg's familiarity is its median point's.
const area = ([lon, lat]) => `${Math.floor(lon / .03)},${Math.floor(lat / .02)}`;
export function familiarity(rides) {
  const passes = new Map();
  for (const points of rides) for (const cell of new Set(points.map(area))) passes.set(cell, (passes.get(cell) ?? 0) + 1);
  return leg => leg.map(point => passes.get(area(point)) ?? 0).sort((a, b) => a - b)[Math.floor(leg.length / 2)];
}

// Osttirol (Bezirk Lienz), roughly: seldom ridden, but the rider's home ground.
export const inOsttirol = ([lon, lat]) => lon >= 12.05 && lon <= 13.06 && lat >= 46.62 && lat <= 47.15;

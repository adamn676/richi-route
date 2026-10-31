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

// The share of line `a`'s length within `tolerance` metres of line `b`, measured every few metres along `a`.
export function shareOn(a, b, tolerance = 20) {
  const toXy = plane(a[0][1]), ax = a.map(toXy), bx = b.map(toXy);
  const cell = 100, grid = new Map();
  for (let i = 1; i < bx.length; i++) {
    const [p, q] = [bx[i - 1], bx[i]];
    for (let x = Math.floor((Math.min(p[0], q[0]) - tolerance) / cell); x <= Math.floor((Math.max(p[0], q[0]) + tolerance) / cell); x++) {
      for (let y = Math.floor((Math.min(p[1], q[1]) - tolerance) / cell); y <= Math.floor((Math.max(p[1], q[1]) + tolerance) / cell); y++) {
        const key = `${x},${y}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(i);
      }
    }
  }
  const near = ([x, y]) => (grid.get(`${Math.floor(x / cell)},${Math.floor(y / cell)}`) ?? []).some(i => {
    const [p, q] = [bx[i - 1], bx[i]], dx = q[0] - p[0], dy = q[1] - p[1], squared = dx * dx + dy * dy;
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

// Rides kept out of training, to check on: about a fifth, fixed by the ride's id.
export const heldOut = id => BigInt(id) % 5n === 0n;

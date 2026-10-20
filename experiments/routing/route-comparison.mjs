// Display-only comparison. Saved coordinates and routing results are never changed.
const tolerance = 3;
const cellSize = 30;

const cell = (x, y) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function pointDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function indexSegments(segments) {
  const grid = new Map();
  for (const segment of segments) {
    const [a, b] = segment.xy;
    for (let x = Math.floor((Math.min(a[0], b[0]) - tolerance) / cellSize); x <= Math.floor((Math.max(a[0], b[0]) + tolerance) / cellSize); x++) {
      for (let y = Math.floor((Math.min(a[1], b[1]) - tolerance) / cellSize); y <= Math.floor((Math.max(a[1], b[1]) + tolerance) / cellSize); y++) {
        const key = `${x},${y}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(segment);
      }
    }
  }
  return grid;
}

function follows(segment, grid) {
  const [a, b] = segment.xy;
  const direction = [b[0] - a[0], b[1] - a[1]];
  return [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b].every(p =>
    (grid.get(cell(...p)) ?? []).some(candidate => {
      const [c, d] = candidate.xy;
      const dot = direction[0] * (d[0] - c[0]) + direction[1] * (d[1] - c[1]);
      return dot > 0.7 * segment.length * candidate.length && pointDistance(p, c, d) <= tolerance;
    }),
  );
}

function differenceAreas(segments) {
  // Adjacent branches form one review area, including both sides of a fork.
  const parents = segments.map((_, index) => index);
  const root = i => parents[i] === i ? i : (parents[i] = root(parents[i]));
  const cells = new Map();
  segments.forEach((segment, index) => {
    const [a, b] = segment.xy;
    const x = Math.floor((a[0] + b[0]) / 2 / cellSize);
    const y = Math.floor((a[1] + b[1]) / 2 / cellSize);
    const middle = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const other of cells.get(`${x + dx},${y + dy}`) ?? []) {
        if (distance(middle, other.middle) <= cellSize) parents[root(index)] = root(other.index);
      }
    }
    const key = `${x},${y}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({ index, middle });
  });
  const groups = new Map();
  segments.forEach((segment, index) => {
    const key = root(index);
    if (!groups.has(key)) groups.set(key, { coordinates: [], length: 0 });
    const group = groups.get(key);
    group.coordinates.push(...segment.coordinates);
    group.length += segment.length;
  });
  return [...groups.values()].filter(group => group.length >= 10).map(group => {
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [lng, lat] of group.coordinates) {
      bounds[0] = Math.min(bounds[0], lng); bounds[1] = Math.min(bounds[1], lat);
      bounds[2] = Math.max(bounds[2], lng); bounds[3] = Math.max(bounds[3], lat);
    }
    return { bounds };
  });
}

/**
 * Group nearby, same-direction geometry for display, not for routing evaluation.
 * Samples stay on the original segments. Three metres accommodates coordinate
 * rounding while keeping distinct parallel paths visible.
 * @param {Array<{id: string, engineId: string, normalized: {geometry: {coordinates: number[][]}} | null}>} results
 * @returns {{data: import('geojson').FeatureCollection<import('geojson').LineString>, differences: Array<{bounds: number[]}>, shared: string[][]}}
 */
export function compareRouteGeometry(results) {
  const routes = results.filter(route => (route.normalized?.geometry.coordinates.length ?? 0) > 1);
  const origin = routes[0]?.normalized.geometry.coordinates[0] ?? [0, 0];
  const scaleX = 111320 * Math.cos(origin[1] * Math.PI / 180);
  const project = p => [(p[0] - origin[0]) * scaleX, (p[1] - origin[1]) * 111320];
  const segments = routes.map(route => {
    const items = [];
    const coordinates = route.normalized.geometry.coordinates;
    for (let i = 1; i < coordinates.length; i++) {
      const a = coordinates[i - 1], b = coordinates[i];
      const length = distance(project(a), project(b));
      const count = Math.ceil(length / 5);
      for (let part = 0; part < count; part++) {
        const interpolate = t => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const coordinates = [interpolate(part / count), interpolate((part + 1) / count)];
        items.push({ coordinates, xy: coordinates.map(project), length: length / count });
      }
    }
    return items;
  });
  const indexes = segments.map(indexSegments);
  const features = [];
  const different = [];
  const shared = new Map();
  segments.forEach((items, routeIndex) => {
    let previous;
    for (const segment of items) {
      const members = routes.flatMap((route, index) => index === routeIndex || follows(segment, indexes[index]) ? [route.id] : []);
      if (routes.length > 1 && members.length < routes.length) different.push(segment);
      if (members.length > 1) shared.set(members.join('|'), members);
      // One representative geometry for each shared stretch.
      if (members[0] !== routes[routeIndex].id) { previous = undefined; continue; }
      const key = members.join('|');
      if (previous?.properties.key === key) {
        previous.geometry.coordinates.push(segment.coordinates[1]);
      } else {
        previous = {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [...segment.coordinates] },
          properties: { key, members, engine: routes[routeIndex].engineId, shared: members.length > 1 },
        };
        features.push(previous);
      }
    }
  });
  return { data: { type: 'FeatureCollection', features }, differences: differenceAreas(different), shared: [...shared.values()] };
}

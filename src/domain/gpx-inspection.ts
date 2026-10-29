import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { cumulativeAscent, type Coord } from './route-model.ts';
import { profileColumn, profileColumns, type GpxTrack } from './gpx-track.ts';

export type GpxColorMode = 'plain' | 'elevation' | 'gradient' | 'surface';
export const unknownGpxColor = '#87939a';
export const elevationColors = ['#3563b5', '#199b9b', '#74a840', '#db9d29', '#bd3c46'];
// Only climbs are told apart; descents share the colour of flat ground.
export const gradientBands = [
  { max: 3, color: '#359a78', label: '< 3 %' },
  { max: 8, color: '#d4a126', label: '3 bis 8 %' },
  { max: 15, color: '#d56b31', label: '8 bis 15 %' },
  { max: Infinity, color: '#b9364f', label: '≥ 15 %' },
];

const gradientBand = (gradient: number) => gradientBands.findIndex(band => gradient < band.max);
export const gradientColor = (gradient: number) => gradientBands[gradientBand(gradient)].color;

// The gradient at each point, over the stretch within `half` metres to either side.
export function gpxGradients(track: GpxTrack, half = 25): (number | null)[][] {
  return track.segments.map((segment, segmentIndex) => {
    const heights = segment.elevations, distances = track.distances[segmentIndex];
    const result: (number | null)[] = Array(heights.length).fill(null);
    let start = 0;
    while (start < heights.length) {
      if (heights[start] === null) { start++; continue; }
      let end = start;
      while (end + 1 < heights.length && heights[end + 1] !== null) end++;
      let left = start, right = start;
      for (let i = start; i <= end; i++) {
        while (left + 1 <= i && distances[left + 1] <= distances[i] - half) left++;
        right = Math.max(right, i);
        while (right < end && distances[right] < distances[i] + half) right++;
        const span = distances[right] - distances[left];
        if (span >= half * .4) {
          const grade = (heights[right]! - heights[left]!) / span * 100;
          if (Number.isFinite(grade)) result[i] = grade;
        }
      }
      start = end + 1;
    }
    return result;
  });
}

function upperBound(length: number, valueAt: (index: number) => number, target: number): number {
  let low = 0, high = length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (valueAt(middle) <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function inspectGpxDistance(track: GpxTrack, gradients: (number | null)[][], requested: number) {
  const distance = Math.max(0, Math.min(track.distanceMeters, requested));
  const segmentIndex = Math.max(0, upperBound(track.segments.length, i => track.distances[i][0], distance) - 1);
  const distances = track.distances[segmentIndex];
  const from = Math.max(0, upperBound(distances.length, i => distances[i], distance) - 1);
  const to = Math.min(distances.length - 1, from + 1);
  const span = distances[to] - distances[from];
  const ratio = span > 0 ? (distance - distances[from]) / span : 0;
  const geometry = track.geojson.features[segmentIndex].geometry;
  const coords = geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates;
  const coordinate: Coord = [coords[from][0] + (coords[to][0] - coords[from][0]) * ratio,
    coords[from][1] + (coords[to][1] - coords[from][1]) * ratio];
  const interpolate = (values: (number | null)[]) => {
    if (ratio === 0) return values[from];
    if (values[from] === null || values[to] === null) return null;
    return values[from]! * (1 - ratio) + values[to]! * ratio;
  };
  return { distance, coordinate, segmentIndex, elevation: interpolate(track.segments[segmentIndex].elevations),
    gradient: interpolate(gradients[segmentIndex]) };
}
export type GpxFocus = ReturnType<typeof inspectGpxDistance>;

function colorFor(track: GpxTrack, mode: GpxColorMode, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return unknownGpxColor;
  if (mode === 'gradient') return gradientColor(value);
  const range = track.profile ? track.profile.maximum - track.profile.minimum : 0;
  const bin = range > 0 ? Math.floor((value - track.profile!.minimum) / range * elevationColors.length) : 2;
  return elevationColors[Math.max(0, Math.min(elevationColors.length - 1, bin))];
}

// Profile colour runs, each from an offset (0–1) along the distance shown. A column takes the steepest climb in it held
// over about its own width (100 to 500 m): a climb shows even where a long column also holds flat ground or a descent,
// which an average would let cancel it, and the stretch's length keeps single height errors out. Its colour fills the
// column only where the line does not fall: it starts at the low point before the climb and ends at the top after it.
// Columns without points continue the previous run, so sparse points on straight roads stay coloured.
export function gradientRuns(track: GpxTrack, from = 0, to = track.distanceMeters) {
  const span = to - from;
  const sustained = gpxGradients(track, Math.min(500, Math.max(100, span / profileColumns)) / 2);
  const columns = Array.from({ length: profileColumns }, () => [] as { distance: number; height: number; band: number }[]);
  track.distances.forEach((distances, s) => distances.forEach((distance, i) => {
    const gradient = sustained[s][i];
    if (gradient === null || distance < from || distance > to) return;
    columns[profileColumn(distance - from, span)].push({ distance, height: track.segments[s].elevations[i]!, band: gradientBand(gradient) });
  }));
  const runs: { from: number; color: string }[] = [];
  let band = -1, previous: typeof columns[number] = [];
  columns.forEach((points, column) => {
    if (!points.length) return;
    const steepest = points.reduce((max, point) => Math.max(max, point.band), 0);
    if (steepest !== band) {
      let turn = steepest > band ? points[0] : previous.at(-1)!, at = column / profileColumns;
      if (steepest > band) {
        for (const point of points) { if (point.height < turn.height) turn = point; if (point.band === steepest) break; }
        if (turn !== points[0]) at = (turn.distance - from) / span;
      } else {
        for (let i = previous.length - 1; i >= 0; i--) { if (previous[i].height > turn.height) turn = previous[i]; if (previous[i].band === band) break; }
        if (turn !== previous.at(-1)) at = (turn.distance - from) / span;
      }
      runs.push({ from: at, color: gradientBands[steepest].color });
      band = steepest;
    }
    previous = points;
  });
  return runs;
}
export type GradientRun = ReturnType<typeof gradientRuns>[number];

// A stretch between two distances: its length, climbing and descent, its mean gradient from end to end and its steepest
// climb held over 100 m, which a single height error does not make.
export function sectionStats(track: GpxTrack, gradients: (number | null)[][], from: number, to: number) {
  const heights: (number | null)[] = [], sustained = gpxGradients(track, 50);
  let steepest: number | null = null;
  track.distances.forEach((distances, s) => distances.forEach((distance, i) => {
    if (distance < from || distance > to) return;
    heights.push(track.segments[s].elevations[i]);
    const gradient = sustained[s][i];
    if (gradient !== null && (steepest === null || gradient > steepest)) steepest = gradient;
  }));
  const start = inspectGpxDistance(track, gradients, from).elevation, end = inspectGpxDistance(track, gradients, to).elevation;
  return { distance: to - from, ascent: cumulativeAscent(heights).at(-1) ?? 0, descent: cumulativeAscent([...heights].reverse()).at(-1) ?? 0,
    gradient: start !== null && end !== null && to > from ? (end - start) / (to - from) * 100 : null, steepest };
}

// The track between two distances, ending exactly there.
export function trackCoordinates(track: GpxTrack, gradients: (number | null)[][], from: number, to: number): Coord[] {
  const inside = track.geojson.features.flatMap((feature, s) => {
    const coords = feature.geometry.type === 'Point' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    return track.distances[s].flatMap((distance, i) => distance > from && distance < to ? [coords[i] as Coord] : []);
  });
  return [inspectGpxDistance(track, gradients, from).coordinate, ...inside, inspectGpxDistance(track, gradients, to).coordinate];
}

export function colorGpxTrack(track: GpxTrack, mode: Exclude<GpxColorMode, 'surface'>, gradients: (number | null)[][]): FeatureCollection<LineString | Point> {
  if (mode === 'plain') return track.geojson;
  const features: Feature<LineString | Point>[] = [];
  const blockMeters = Math.max(50, track.distanceMeters / 5000);
  track.segments.forEach((segment, s) => {
    const original = track.geojson.features[s].geometry;
    const coordinates = original.type === 'Point' ? [original.coordinates] : original.coordinates;
    const values = mode === 'gradient' ? gradients[s] : segment.elevations;
    if (coordinates.length === 1) {
      features.push({ type: 'Feature', properties: { color: colorFor(track, mode, values[0]), segment: s }, geometry: original });
      return;
    }
    let start = 0;
    let current: Feature<LineString> | undefined;
    while (start < coordinates.length - 1) {
      let end = start + 1;
      let known = values[start] !== null;
      while (end < coordinates.length - 1 && track.distances[s][end] - track.distances[s][start] < blockMeters) {
        known &&= values[end] !== null;
        end++;
      }
      known &&= values[end] !== null;
      const value = known ? (values[start]! / 2 + values[end]! / 2) : null;
      const color = colorFor(track, mode, value);
      if (!current || current.properties?.color !== color) {
        current = { type: 'Feature', properties: { color, segment: s }, geometry: { type: 'LineString', coordinates: [coordinates[start]] } };
        features.push(current);
      }
      for (let i = start + 1; i <= end; i++) current.geometry.coordinates.push(coordinates[i]);
      start = end;
    }
  });
  return { type: 'FeatureCollection', features };
}

export function gpxEndpoints(track: GpxTrack): FeatureCollection<Point> {
  const features: Feature<Point>[] = [];
  track.geojson.features.forEach((feature, segment) => {
    const coordinates = feature.geometry.type === 'Point' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    const first = coordinates[0], last = coordinates[coordinates.length - 1];
    const closed = first[0] === last[0] && first[1] === last[1];
    features.push({ type: 'Feature', properties: { icon: closed ? 'gpx-both' : 'gpx-start', segment }, geometry: { type: 'Point', coordinates: first } });
    if (!closed) features.push({ type: 'Feature', properties: { icon: 'gpx-end', segment }, geometry: { type: 'Point', coordinates: last } });
  });
  return { type: 'FeatureCollection', features };
}

// Distance along the track of its nearest point within `radius` metres of a coordinate, or null.
export function nearestTrackDistance(track: GpxTrack, coord: Coord, radius: number): number | null {
  const metresX = 111320 * Math.cos(coord[1] * Math.PI / 180), metresY = 110540;
  let best: { offset: number; distance: number } | undefined;
  track.segments.forEach((segment, s) => {
    const points = segment.coordinates.map(([lng, lat]) => [(lng - coord[0]) * metresX, (lat - coord[1]) * metresY]);
    const distances = track.distances[s];
    for (let i = 0; i < points.length; i++) {
      const [ax, ay] = points[i], [bx, by] = points[Math.min(i + 1, points.length - 1)];
      const length = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = length ? Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / length)) : 0;
      const offset = Math.hypot(ax + t * (bx - ax), ay + t * (by - ay));
      if (offset <= radius && (!best || offset < best.offset)) {
        best = { offset, distance: distances[i] + t * (distances[Math.min(i + 1, points.length - 1)] - distances[i]) };
      }
    }
  });
  return best?.distance ?? null;
}

// Compass bearing from one coordinate to another, in degrees clockwise from north.
export function bearing([lng1, lat1]: Coord, [lng2, lat2]: Coord): number {
  const rad = Math.PI / 180, dLng = (lng2 - lng1) * rad;
  const y = Math.sin(dLng) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos(dLng);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

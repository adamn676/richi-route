import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import type { Coord } from './route-model.ts';
import type { GpxTrack } from './gpx-track.ts';

export type GpxColorMode = 'plain' | 'elevation' | 'gradient';
export const unknownGpxColor = '#87939a';
export const elevationColors = ['#3563b5', '#199b9b', '#74a840', '#db9d29', '#bd3c46'];
export const gradientBands = [
  { max: -10, color: '#3156a6', label: '< −10 %' },
  { max: -3, color: '#318ec1', label: '−10 bis −3 %' },
  { max: 3, color: '#359a78', label: '−3 bis 3 %' },
  { max: 8, color: '#d4a126', label: '3 bis 8 %' },
  { max: 15, color: '#d56b31', label: '8 bis 15 %' },
  { max: Infinity, color: '#b9364f', label: '≥ 15 %' },
];

export function gpxGradients(track: GpxTrack): (number | null)[][] {
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
        while (left + 1 <= i && distances[left + 1] <= distances[i] - 25) left++;
        right = Math.max(right, i);
        while (right < end && distances[right] < distances[i] + 25) right++;
        const span = distances[right] - distances[left];
        if (span >= 10) {
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
  if (mode === 'gradient') return gradientBands.find(band => value < band.max)!.color;
  const range = track.profile ? track.profile.maximum - track.profile.minimum : 0;
  const bin = range > 0 ? Math.floor((value - track.profile!.minimum) / range * elevationColors.length) : 2;
  return elevationColors[Math.max(0, Math.min(elevationColors.length - 1, bin))];
}

export function colorGpxTrack(track: GpxTrack, mode: GpxColorMode, gradients: (number | null)[][]): FeatureCollection<LineString | Point> {
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

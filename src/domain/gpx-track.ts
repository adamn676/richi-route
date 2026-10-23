import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { distanceMeters, type Coord } from './route-model.ts';

export interface GpxSegment {
  name: string;
  coordinates: Coord[];
  elevations: (number | null)[];
}

interface ProfileSample { distance: number; height: number; index: number; run: number }
interface ProfileBucket { run: number; first: ProfileSample; last: ProfileSample; min: ProfileSample; max: ProfileSample }

export function buildGpxTrack(name: string, fileName: string, segments: GpxSegment[]) {
  let distance = 0, pointCount = 0, elevationCount = 0, ascent = 0, run = 0;
  let minimum = Infinity, maximum = -Infinity;
  const samples: ProfileSample[] = [];
  const features: Feature<LineString | Point>[] = [];
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  const anchor = segments[0]?.coordinates[0]?.[0] ?? 0;

  for (const segment of segments) {
    run++;
    let previousLongitude = anchor;
    const displayCoordinates: Coord[] = [];
    for (let i = 0; i < segment.coordinates.length; i++) {
      const coord = segment.coordinates[i];
      const elevation = segment.elevations[i];
      if (i > 0) distance += distanceMeters(segment.coordinates[i - 1], coord);
      pointCount++;
      if (elevation === null) run++;
      else {
        elevationCount++;
        minimum = Math.min(minimum, elevation);
        maximum = Math.max(maximum, elevation);
        samples.push({ distance, height: elevation, index: pointCount, run });
        const previous = segment.elevations[i - 1];
        if (i > 0 && previous !== null) ascent += Math.max(0, elevation - previous);
      }
      // Shift whole worlds for display only; keep the imported coordinates unchanged.
      const longitude = coord[0] + 360 * Math.round((previousLongitude - coord[0]) / 360);
      previousLongitude = longitude;
      displayCoordinates.push(longitude === coord[0] ? coord : [longitude, coord[1]]);
      west = Math.min(west, longitude); east = Math.max(east, longitude);
      south = Math.min(south, coord[1]); north = Math.max(north, coord[1]);
    }
    if (displayCoordinates.length) features.push({
      type: 'Feature', properties: { name: segment.name },
      geometry: displayCoordinates.length === 1
        ? { type: 'Point', coordinates: displayCoordinates[0] }
        : { type: 'LineString', coordinates: displayCoordinates },
    });
  }

  if (elevationCount && (!Number.isFinite(maximum - minimum) || !Number.isFinite(ascent))) {
    throw new Error('Die GPX-Höhenwerte sind für eine Auswertung zu groß.');
  }

  // Bound the SVG work by chart width, retaining extrema within continuous runs.
  const buckets: (ProfileBucket | undefined)[] = Array(300);
  for (const sample of samples) {
    const index = distance > 0 ? Math.min(299, Math.floor(sample.distance / distance * 300)) : 0;
    const bucket = buckets[index];
    if (!bucket) buckets[index] = { run: sample.run, first: sample, last: sample, min: sample, max: sample };
    else if (bucket.run !== sample.run) bucket.run = -1;
    else {
      bucket.last = sample;
      if (sample.height < bucket.min.height) bucket.min = sample;
      if (sample.height > bucket.max.height) bucket.max = sample;
    }
  }
  const selected = samples.length <= 1200 ? samples : buckets.flatMap(bucket =>
    !bucket || bucket.run < 0 ? [] : [...new Set([bucket.first, bucket.min, bucket.max, bucket.last])].sort((a, b) => a.index - b.index));
  let path = '', previousRun = -1;
  for (const sample of selected) {
    const x = 5 + (distance > 0 ? sample.distance / distance * 290 : 0);
    const y = 78 - (sample.height - minimum) / Math.max(1, maximum - minimum) * 68;
    path += `${sample.run === previousRun ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
    if (sample.run !== previousRun) path += 'l0.01,0 ';
    previousRun = sample.run;
  }
  const mapLatitude = (latitude: number) => Math.max(-85.051129, Math.min(85.051129, latitude));
  return {
    name, fileName, segments, pointCount, elevationCount, distanceMeters: distance,
    ascentMeters: elevationCount === pointCount && pointCount > segments.length ? ascent : null,
    profile: elevationCount ? { minimum, maximum, path } : null,
    bounds: [[west, mapLatitude(south)], [east, mapLatitude(north)]] as [Coord, Coord],
    geojson: { type: 'FeatureCollection', features } as FeatureCollection<LineString | Point>,
  };
}

export type GpxTrack = ReturnType<typeof buildGpxTrack>;

import type { FeatureCollection, Point } from 'geojson';
import { storedFile } from './offline-files';
import { deviceAreas, onDeviceChange, overlaps, type Bounds } from './offline-storage';

// Water, repair stations, bike shops and stations from the offline areas on the device, for when the map service is out
// of reach; each area's file is read once.
const files = new Map<string, Promise<FeatureCollection<Point> | null>>();
onDeviceChange(() => files.clear());

// The points within the bounds, or null without an area on the device there.
export async function deviceCyclingPoints(bounds: Bounds): Promise<FeatureCollection<Point> | null> {
  const areas = deviceAreas().filter(area => overlaps(area.bounds, bounds));
  if (!areas.length) return null;
  const [west, south, east, north] = bounds, seen = new Set<unknown>();
  const features = (await Promise.all(areas.map(({ id }) => {
    if (!files.has(id)) files.set(id, storedFile(`areas/${id}/cycling.json`).then(file => file && file.text()).then(text => text && JSON.parse(text)).catch(() => null));
    return files.get(id)!;
  }))).flatMap(points => points?.features ?? []).filter(feature => {
    const [lon, lat] = feature.geometry.coordinates;
    if (lon < west || lon > east || lat < south || lat > north || seen.has(feature.id)) return false;
    seen.add(feature.id);
    return true;
  });
  return { type: 'FeatureCollection', features };
}

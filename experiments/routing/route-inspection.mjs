import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { distanceM } from './engines.mjs';
import { readRun, root } from './run.mjs';

// ORS surface IDs: https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/extra-info/surface
const orsSurfaces = ['unknown', 'paved', 'unpaved', 'asphalt', 'concrete', 'cobblestone', 'metal', 'wood', 'compacted', 'fine_gravel', 'gravel', 'dirt', 'ground', 'ice', 'paving_stones', 'sand', 'woodchips', 'grass', 'grass_paver'];
const unknown = value => !value || ['missing', 'other', 'unknown'].includes(value);

export function inspectRoute(engineId, raw) {
  const route = engineId === 'graphhopper' ? raw.paths?.[0] : raw.features?.find(feature => feature.geometry?.type === 'LineString');
  const coordinates = (engineId === 'graphhopper' ? route?.points : route?.geometry)?.coordinates;
  if (!coordinates || coordinates.length < 2) throw new Error('Saved route geometry is unavailable.');
  const properties = engineId === 'graphhopper' ? route : route.properties;
  const surfaces = Array(coordinates.length - 1).fill('unknown');
  if (engineId === 'brouter') {
    const [header, ...rows] = properties.messages ?? [];
    const lon = header?.indexOf('Longitude') ?? -1;
    const lat = header?.indexOf('Latitude') ?? -1;
    const tags = header?.indexOf('WayTags') ?? -1;
    const length = header?.indexOf('Distance') ?? -1;
    let start = 0;
    if (lon >= 0 && lat >= 0 && tags >= 0) {
      for (const row of rows) {
        let end = start + (length >= 0 && Number(row[length]) > 0 ? 1 : 0);
        while (end < coordinates.length && !(Math.round(coordinates[end][0] * 1e6) === Number(row[lon]) && Math.round(coordinates[end][1] * 1e6) === Number(row[lat]))) end++;
        if (end === coordinates.length) break;
        const value = /(?:^|\s)surface=([^\s]+)/.exec(row[tags] ?? '')?.[1];
        surfaces.fill(unknown(value) ? 'unknown' : value, start, end);
        start = end;
      }
    }
  } else {
    const intervals = engineId === 'graphhopper' ? properties.details?.surface : properties.extras?.surface?.values;
    for (const [start, end, rawValue] of intervals ?? []) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end >= coordinates.length) continue;
      const value = engineId === 'ors' ? orsSurfaces[rawValue] : rawValue;
      surfaces.fill(unknown(value) ? 'unknown' : value, start, end);
    }
  }
  const distances = [0];
  for (let index = 1; index < coordinates.length; index++) {
    distances.push(distances[index - 1] + distanceM(coordinates[index - 1], coordinates[index]));
  }
  const sections = [];
  surfaces.forEach((surface, index) => {
    const previous = sections.at(-1);
    if (previous?.surface === surface) {
      previous.toIndex = index + 1;
      previous.toM = distances[index + 1];
    } else {
      sections.push({ surface, fromIndex: index, toIndex: index + 1, fromM: distances[index], toM: distances[index + 1] });
    }
  });
  // Missing heights remain gaps; never substitute another engine's route or zero.
  const elevations = coordinates.map(coord => typeof coord[2] === 'number' && Number.isFinite(coord[2]) && coord[2] !== -32768 ? coord[2] : null);
  return {
    coordinates: coordinates.map(coord => coord.slice(0, 2)),
    distances, elevations, sections,
    ascentM: engineId === 'brouter' && properties['filtered ascend'] != null && Number.isFinite(Number(properties['filtered ascend'])) ? Number(properties['filtered ascend']) : null,
    surfaceSource: engineId === 'ors' ? 'ORS surface categories' : `${engineId === 'brouter' ? 'BRouter' : 'GraphHopper'} surface tags`,
  };
}

export async function loadRouteInspection(runId, resultId) {
  const run = await readRun(runId);
  const result = run.results.find(result => result.id === resultId && result.status === 'ok');
  if (!result) throw new Error('Select a successful saved route.');
  const raw = JSON.parse(await readFile(path.join(root, '.local/runs', runId, `${result.id}.response.txt`), 'utf8'));
  return inspectRoute(result.engineId, raw);
}

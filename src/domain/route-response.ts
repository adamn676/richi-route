import { cumulativeAscent, routerClimbThreshold, type Coord, type LegGeometry, type Surface, type SurfaceSpan } from './route-model.ts';

// The material does not matter on a road bike, only whether it is paved; cobblestones are paved but rough.
export function surfaceType(tag: string | undefined): Surface {
  if (['asphalt', 'paved', 'concrete', 'concrete:lanes', 'concrete:plates', 'paving_stones'].includes(tag ?? '')) return 'paved';
  if (['cobblestone', 'sett', 'unhewn_cobblestone', 'wood'].includes(tag ?? '')) return 'rough';
  if (['unpaved', 'gravel', 'fine_gravel', 'compacted', 'ground', 'dirt', 'earth', 'grass', 'grass_paver', 'sand', 'mud', 'clay', 'rock',
    'pebblestone', 'woodchips'].includes(tag ?? '')) return 'unpaved';
  return 'unknown';
}

// Without a surface tag the groups know, the way's type: on the planner's loop suggestions (October 2026) tagged ways of
// these types are 95–100 % paved, tracks of grade 2 to 5 95–99 % unpaved. Paths and tracks without a grade stay unknown.
const likelyPavedWays = new Set(['trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'unclassified', 'residential', 'service', 'cycleway']);
export function surfaceByWayType(wayTags: string): Surface {
  const highway = /(?:^|\s)highway=([^\s]+)/.exec(wayTags)?.[1] ?? '', grade = /(?:^|\s)tracktype=([^\s]+)/.exec(wayTags)?.[1];
  if (likelyPavedWays.has(highway) || (highway === 'track' && grade === 'grade1')) return 'likelyPaved';
  return highway === 'track' && /^grade[2-5]$/.test(grade ?? '') ? 'unpaved' : 'unknown';
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseBRouterLine(raw: unknown) {
  const features = record(raw).features;
  const feature = Array.isArray(features) ? features.find(value => record(record(value).geometry).type === 'LineString') : undefined;
  const geometry = record(record(feature).geometry);
  if (!Array.isArray(geometry.coordinates) || !geometry.coordinates.length) throw new Error('Routing lieferte keine Streckenpunkte.');
  const coordinates: Coord[] = geometry.coordinates.map(value => {
    if (!Array.isArray(value) || !Number.isFinite(value[0]) || !Number.isFinite(value[1]) || Math.abs(value[0]) > 180 || Math.abs(value[1]) > 90) {
      throw new Error('Routing lieferte ungültige Streckenpunkte.');
    }
    return [value[0], value[1]];
  });
  const elevations = geometry.coordinates.every(value => Array.isArray(value) && typeof value[2] === 'number' && Number.isFinite(value[2]))
    ? geometry.coordinates.map(value => (value as number[])[2]) : null;
  return { coordinates, elevations, properties: record(record(feature).properties) };
}

export function parseBRouterLeg(raw: unknown): LegGeometry {
  const { coordinates, properties, elevations } = parseBRouterLine(raw);
  const distanceMeters = Number(properties['track-length']);
  if (properties['track-length'] == null || !Number.isFinite(distanceMeters) || distanceMeters < 0 || (coordinates.length === 1 && distanceMeters !== 0)) {
    throw new Error('Routing lieferte keine gültige Streckenlänge.');
  }
  const surfaces: SurfaceSpan[] = [];
  const messages = properties.messages;
  if (Array.isArray(messages) && Array.isArray(messages[0])) {
    const header = messages[0];
    const lon = header.indexOf('Longitude');
    const lat = header.indexOf('Latitude');
    const tags = header.indexOf('WayTags');
    const distance = header.indexOf('Distance');
    let start = 0;
    if (lon >= 0 && lat >= 0 && tags >= 0) {
      for (const row of messages.slice(1)) {
        if (!Array.isArray(row)) break;
        let end = start + (distance >= 0 && Number(row[distance]) > 0 ? 1 : 0);
        while (end < coordinates.length && !(Math.round(coordinates[end][0] * 1e6) === Number(row[lon]) && Math.round(coordinates[end][1] * 1e6) === Number(row[lat]))) end++;
        if (end === coordinates.length) break; // Unmatched spans remain unknown.
        if (end > start) {
          const wayTags = typeof row[tags] === 'string' ? row[tags] : '';
          const tag = /(?:^|\s)surface=([^\s]+)/.exec(wayTags)?.[1];
          const tagged = surfaceType(tag);
          const surface = tagged === 'unknown' ? surfaceByWayType(wayTags) : tagged;
          const previous = surfaces.at(-1);
          if (previous?.surface === surface && previous.surfaceTag === tag && previous.toIndex === start) previous.toIndex = end;
          else surfaces.push({ fromIndex: start, toIndex: end, surface, ...(tag ? { surfaceTag: tag } : {}) });
        }
        start = end;
      }
    }
  }
  if (coordinates.length === 1) {
    coordinates.push([...coordinates[0]]);
    if (elevations) elevations.push(elevations[0]);
  }
  // BRouter's filtered ascent runs about a tenth low, so its heights are filtered like file heights, only coarser.
  const ascent = properties['filtered ascend'];
  const ascentMeters = elevations ? cumulativeAscent(elevations, routerClimbThreshold).at(-1)!
    : ascent != null && Number.isFinite(Number(ascent)) ? Number(ascent) : null;
  return { coordinates, distanceMeters, elevations, surfaces, ascentMeters };
}

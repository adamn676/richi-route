import { settingsFor } from './profiles.mjs';

export const engines = {
  graphhopper: { version: '11.1', profile: 'racingbike', endpoint: 'http://127.0.0.1:8989/route', elevation: 'none' },
  brouter: { version: '1.7.10', patch: 'local-bicycle-v2', profile: 'richi-road', endpoint: 'http://127.0.0.1:17777/brouter', elevation: 'prepared RD5 data' },
  ors: { version: '10.1.0', patch: 'missing-endpoint-v1', profile: 'cycling-road', endpoint: 'http://127.0.0.1:8082/ors/v2/directions/cycling-road/geojson', elevation: 'none' },
};

export function variants(scenario) {
  const result = [
    { name: 'automatic', points: scenario.points.filter((point) => point.role === 'stop') },
    { name: 'selected', points: scenario.points },
  ];
  if (scenario.edit) {
    const { pointIndex, coord } = scenario.edit;
    if (scenario.points[pointIndex]?.role !== 'shape') throw new Error('Edits must target a shaping point.');
    result.push({ name: 'edited', points: scenario.points.map((point, index) => index === pointIndex ? { ...point, coord } : point) });
  }
  return result;
}

export function requestFor(engineId, points, settings = 'baseline') {
  const preset = settingsFor(settings);
  const engine = Object.hasOwn(engines, engineId) ? engines[engineId] : undefined;
  if (!engine) throw new Error(`Unsupported engine: ${engineId}. Hosted routing is disabled.`);
  if (points.length < 2 || points.some(({ coord }) => coord.length !== 2 || !coord.every(Number.isFinite) || Math.abs(coord[0]) > 180 || Math.abs(coord[1]) > 90)) {
    throw new Error('Expected at least two valid longitude/latitude pairs.');
  }
  const url = new URL(engine.endpoint);
  if (engineId === 'ors') return {
    method: 'POST', url: url.href,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coordinates: points.map(point => point.coord), instructions: false, elevation: false, extra_info: ['surface'] }),
  };
  url.searchParams.set('profile', engineId === 'brouter' ? preset.brouterProfile : engine.profile);
  if (engineId === 'graphhopper') {
    for (const { coord: [lon, lat] } of points) url.searchParams.append('point', `${lat},${lon}`);
    url.searchParams.set('points_encoded', 'false');
    url.searchParams.set('instructions', 'false');
    url.searchParams.set('calc_points', 'true');
    url.searchParams.set('way_point_max_distance', '0');
    for (const detail of ['surface', 'smoothness', 'road_class']) url.searchParams.append('details', detail);
  } else {
    if (preset.brouterNogos) url.searchParams.set('nogos', preset.brouterNogos);
    url.searchParams.set('lonlats', points.map(({ coord }) => coord.join(',')).join('|'));
    url.searchParams.set('alternativeidx', '0');
    url.searchParams.set('format', 'geojson');
  }
  return { method: 'GET', url: url.href };
}

export function distanceM(a, b) {
  const rad = Math.PI / 180;
  const lat = (b[1] - a[1]) * rad;
  const lon = (b[0] - a[0]) * rad;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(lon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function surfaceCoverage(coordinates, intervals = []) {
  const values = Array(coordinates.length - 1).fill(null);
  for (const [start, end, value] of intervals) {
    for (let i = start; i < Math.min(end, values.length); i++) values[i] = value;
  }
  let totalM = 0;
  let unknownM = 0;
  for (let i = 0; i < values.length; i++) {
    const length = distanceM(coordinates[i], coordinates[i + 1]);
    totalM += length;
    if (!values[i] || ['missing', 'other', 'unknown'].includes(String(values[i]).toLowerCase())) unknownM += length;
  }
  return { unknownSurfaceM: Math.round(unknownM), unknownSurfacePercent: totalM ? 100 * unknownM / totalM : null };
}

function numberOrNull(value) {
  return value !== undefined && value !== null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function brouterSurfaceCoverage(properties, coordinates) {
  const [header, ...messages] = properties.messages ?? [];
  const distanceIndex = header?.indexOf('Distance') ?? -1;
  const tagsIndex = header?.indexOf('WayTags') ?? -1;
  if (distanceIndex < 0 || tagsIndex < 0) return surfaceCoverage(coordinates);
  let totalM = 0;
  let unknownM = 0;
  for (const message of messages) {
    const length = numberOrNull(message[distanceIndex]);
    if (length === null || length < 0) return surfaceCoverage(coordinates);
    totalM += length;
    const surface = /(?:^|\s)surface=([^\s]+)/.exec(message[tagsIndex] ?? '')?.[1];
    if (!surface || ['unknown', 'missing', 'other'].includes(surface)) unknownM += length;
  }
  return { unknownSurfaceM: Math.round(unknownM), unknownSurfacePercent: totalM ? 100 * unknownM / totalM : null };
}

export function normalize(engineId, raw) {
  const path = engineId === 'graphhopper' ? raw.paths?.[0] : raw.features?.find((feature) => feature.geometry?.type === 'LineString');
  const geometry = engineId === 'graphhopper' ? path?.points : path?.geometry;
  if (geometry?.type !== 'LineString' || geometry.coordinates.length < 2 || geometry.coordinates.some((coord) => coord.length < 2 || !coord.every(Number.isFinite))) {
    throw new Error('Engine did not return a valid route LineString.');
  }
  const properties = engineId === 'graphhopper' ? path : path.properties;
  if (engineId === 'ors') {
    const surface = properties.extras?.surface?.values ?? [];
    return {
      geometry,
      distanceM: numberOrNull(properties.summary?.distance),
      durationS: numberOrNull(properties.summary?.duration),
      ascentM: null,
      details: { surface },
      ...surfaceCoverage(geometry.coordinates, surface),
      attributeNote: 'Unknown surface uses geometry lengths and ORS surface codes; zero or absent codes are unknown. Local cycling-road profile, no elevation. This does not reproduce the hosted service configuration or the original editor’s shaping logic.',
    };
  }
  const details = engineId === 'graphhopper' ? path.details ?? {} : {};
  return {
    geometry,
    distanceM: numberOrNull(engineId === 'graphhopper' ? properties.distance : properties['track-length']),
    durationS: engineId === 'graphhopper' ? (numberOrNull(properties.time) === null ? null : properties.time / 1000) : numberOrNull(properties['total-time']),
    ascentM: engineId === 'graphhopper' ? null : numberOrNull(properties['filtered ascend']),
    details,
    ...(engineId === 'graphhopper' ? surfaceCoverage(geometry.coordinates, details.surface) : brouterSurfaceCoverage(properties, geometry.coordinates)),
    attributeNote: engineId === 'graphhopper' ? 'Unknown surface uses geometry lengths and GraphHopper encoded values. No elevation in this baseline.' : 'Unknown surface uses BRouter message distances and surface tags. Distance rounding and data preparation differ from GraphHopper.',
  };
}

export async function route(engineId, points, fetcher = fetch, settings = 'baseline') {
  const request = requestFor(engineId, points, settings);
  const started = performance.now();
  let rawText = null;
  let httpStatus = null;
  try {
    const response = await fetcher(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: 'error', signal: AbortSignal.timeout(70_000) });
    httpStatus = response.status;
    rawText = await response.text();
    const responseMs = performance.now() - started;
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${rawText.slice(0, 500)}`);
    const normalized = normalize(engineId, JSON.parse(rawText));
    return { status: 'ok', request, httpStatus, rawText, responseMs, normalized };
  } catch (error) {
    return { status: 'error', request, httpStatus, rawText, responseMs: performance.now() - started, error: error.message, normalized: null };
  }
}

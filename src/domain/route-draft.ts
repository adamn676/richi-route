import { distanceMeters, isPlaced, reconcileLegs, sameEndpoints, type Coord, type RouteLeg, type RoutePoint, type SurfaceSpan } from './route-model.ts';

export interface RouteDraft {
  version: 1;
  points: RoutePoint[];
  legs: Record<string, RouteLeg>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid draft object');
  return value as Record<string, unknown>;
}

function coord(value: unknown): Coord {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(v => typeof v === 'number' && Number.isFinite(v)) ||
      Math.abs(value[0]) > 180 || Math.abs(value[1]) > 90) throw new Error('Invalid draft coordinate');
  return [value[0], value[1]];
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid draft text');
  return value;
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid draft number');
  return value;
}

function point(value: unknown): RoutePoint {
  const p = object(value);
  const id = text(p.id);
  if (!/^(stop|shape)-[\w-]+$/.test(id)) throw new Error('Invalid draft point ID');
  const common = {
    id,
    ...(p.snapPending === true ? { snapPending: true } : {}),
    ...(p.snapError !== undefined ? { snapError: text(p.snapError) } : {}),
  };
  if (p.type === 'shape') return { ...common, type: 'shape', coord: coord(p.coord) };
  if (p.type !== 'stop' || !['start', 'via', 'end'].includes(text(p.kind))) throw new Error('Invalid draft stop');
  return {
    ...common, type: 'stop', kind: p.kind as 'start' | 'via' | 'end',
    coord: p.coord === null ? null : coord(p.coord),
    ...(p.routingCoord !== undefined ? { routingCoord: coord(p.routingCoord) } : {}),
    address: p.address === null ? null : text(p.address),
    userInput: text(p.userInput), isGeocoding: false,
  };
}

function leg(value: unknown): RouteLeg {
  const l = object(value);
  if (!Array.isArray(l.coordinates) || l.coordinates.length < 2 || !Array.isArray(l.surfaces) ||
      !['air', 'routed'].includes(text(l.status))) throw new Error('Invalid draft leg');
  const coordinates = l.coordinates.map(coord);
  const elevations = l.elevations === null ? null : Array.isArray(l.elevations) ? l.elevations.map(number) : undefined;
  if (elevations === undefined || (elevations && elevations.length !== coordinates.length)) throw new Error('Invalid draft elevations');
  let previousEnd = 0;
  const surfaces: SurfaceSpan[] = l.surfaces.map(value => {
    const s = object(value);
    const fromIndex = number(s.fromIndex), toIndex = number(s.toIndex);
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < previousEnd ||
        toIndex <= fromIndex || toIndex >= coordinates.length ||
        !['asphalt', 'paved', 'rough', 'unpaved', 'unknown'].includes(text(s.surface))) throw new Error('Invalid draft surface');
    previousEnd = toIndex;
    if (s.surfaceTag !== undefined && (typeof s.surfaceTag !== 'string' || !s.surfaceTag.length || s.surfaceTag.length > 200)) {
      throw new Error('Invalid draft surface tag');
    }
    return { fromIndex, toIndex, surface: s.surface as SurfaceSpan['surface'],
      ...(s.surfaceTag !== undefined ? { surfaceTag: s.surfaceTag as string } : {}) };
  });
  const result: RouteLeg = {
    id: text(l.id), fromId: text(l.fromId), toId: text(l.toId),
    fromCoord: coord(l.fromCoord), toCoord: coord(l.toCoord),
    coordinates, elevations, surfaces,
    distanceMeters: number(l.distanceMeters),
    ascentMeters: l.ascentMeters === null ? null : number(l.ascentMeters),
    status: l.status as RouteLeg['status'],
    ...(l.routingPolicy !== undefined ? { routingPolicy: text(l.routingPolicy) } : {}),
    ...(l.error !== undefined ? { error: text(l.error) } : {}),
  };
  if (result.routingPolicy !== undefined && (!result.routingPolicy.length || result.routingPolicy.length > 200)) throw new Error('Invalid routing policy version');
  if (result.distanceMeters < 0 || (result.ascentMeters !== null && result.ascentMeters < 0) ||
      distanceMeters(result.fromCoord, coordinates[0]) > 2 ||
      distanceMeters(result.toCoord, coordinates.at(-1)!) > 2) throw new Error('Invalid draft leg endpoints');
  return result;
}

export function parseDraft(raw: string): RouteDraft {
  const data = object(JSON.parse(raw));
  if (data.version !== 1 || !Array.isArray(data.points)) throw new Error('Unsupported draft version');
  const points = data.points.map(point);
  const last = points.at(-1);
  if (points.length < 2 || new Set(points.map(p => p.id)).size !== points.length ||
      points[0].type !== 'stop' || points[0].kind !== 'start' ||
      last?.type !== 'stop' || last.kind !== 'end' ||
      points.slice(1, -1).some(p => p.type === 'stop' && p.kind !== 'via')) throw new Error('Invalid draft point order');
  const expected = reconcileLegs(points, {}).legs;
  const legs: Record<string, RouteLeg> = {};
  for (const [id, value] of Object.entries(object(data.legs))) {
    if (!Object.hasOwn(expected, id)) throw new Error('Unexpected draft leg');
    const parsed = leg(value);
    if (parsed.id !== id || !sameEndpoints(parsed, expected[id])) throw new Error('Stale draft leg');
    legs[id] = parsed;
  }
  return { version: 1, points, legs };
}

export function serializeDraft(points: RoutePoint[], legs: Record<string, RouteLeg>): string {
  // Keep completed geometry; pending points and missing legs resume on restoration.
  const expected = reconcileLegs(points, {}).legs;
  return JSON.stringify({
    version: 1, points: points.map(p => p.type === 'stop' ? { ...p, isGeocoding: false } : p),
    legs: Object.fromEntries(Object.entries(legs).filter(([id, l]) =>
      Object.hasOwn(expected, id) && sameEndpoints(l, expected[id]))),
  });
}

export function hasDraftPoints(points: RoutePoint[]): boolean {
  return points.some(isPlaced) || points.some(p => p.type === 'stop' && p.userInput !== '');
}

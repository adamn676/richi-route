export type Coord = [number, number];
export type StopKind = 'start' | 'via' | 'end';
export type Surface = 'asphalt' | 'paved' | 'rough' | 'unpaved' | 'unknown';

export interface Waypoint {
  id: string;
  type: 'stop';
  kind: StopKind;
  coord: Coord | null;
  routingCoord?: Coord;
  snapPending?: boolean;
  snapError?: string;
  address: string | null;
  userInput: string;
  isGeocoding: boolean;
}

export interface ShapePoint {
  id: string;
  type: 'shape';
  coord: Coord;
  snapPending?: boolean;
  snapError?: string;
}

export type RoutePoint = Waypoint | ShapePoint;

export interface SurfaceSpan {
  fromIndex: number;
  toIndex: number;
  surface: Surface;
}

export interface LegGeometry {
  coordinates: Coord[];
  distanceMeters: number;
  ascentMeters: number | null;
  elevations: number[] | null;
  surfaces: SurfaceSpan[];
}

export interface RoutingEngine {
  snap(coord: Coord, signal: AbortSignal): Promise<Coord>;
  routeLeg(from: Coord, to: Coord, signal: AbortSignal): Promise<LegGeometry>;
}

export interface RouteLeg extends LegGeometry {
  id: string;
  fromId: string;
  toId: string;
  fromCoord: Coord;
  toCoord: Coord;
  status: 'routed' | 'air';
  error?: string;
}

export interface LegRequest {
  id: string;
  fromId: string;
  toId: string;
  fromCoord: Coord;
  toCoord: Coord;
}

export function legId(fromId: string, toId: string): string {
  return `${fromId}:${toId}`;
}

export function isPlaced(point: RoutePoint): point is RoutePoint & { coord: Coord } {
  return point.coord !== null;
}

export function distanceMeters(from: Coord, to: Coord): number {
  const radians = Math.PI / 180;
  const lat1 = from[1] * radians;
  const lat2 = to[1] * radians;
  const latDifference = lat2 - lat1;
  const lonDifference = (to[0] - from[0]) * radians;
  const a =
    Math.sin(latDifference / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(lonDifference / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
}

export function airLeg(request: LegRequest, error?: string): RouteLeg {
  return {
    ...request,
    coordinates: [[...request.fromCoord], [...request.toCoord]],
    distanceMeters: distanceMeters(request.fromCoord, request.toCoord),
    ascentMeters: null,
    elevations: null,
    surfaces: [],
    status: 'air',
    ...(error ? { error } : {}),
  };
}

export function sameEndpoints(leg: RouteLeg, request: LegRequest): boolean {
  return (
    leg.fromId === request.fromId &&
    leg.toId === request.toId &&
    leg.fromCoord[0] === request.fromCoord[0] &&
    leg.fromCoord[1] === request.fromCoord[1] &&
    leg.toCoord[0] === request.toCoord[0] &&
    leg.toCoord[1] === request.toCoord[1]
  );
}

export function reconcileLegs(
  points: RoutePoint[],
  previous: Record<string, RouteLeg>,
  optimize = false,
): { legs: Record<string, RouteLeg>; requests: LegRequest[] } {
  const placed = points.filter(isPlaced);
  const legs: Record<string, RouteLeg> = {};
  const requests: LegRequest[] = [];

  for (let index = 0; index < placed.length - 1; index++) {
    const from = placed[index];
    const to = placed[index + 1];
    const request: LegRequest = {
      id: legId(from.id, to.id),
      fromId: from.id,
      toId: to.id,
      fromCoord: [...(index === 0 && from.type === 'stop' ? from.routingCoord ?? from.coord : from.coord)],
      toCoord: [...(index === placed.length - 2 && to.type === 'stop' ? to.routingCoord ?? to.coord : to.coord)],
    };
    const existing = previous[request.id];
    if (existing && sameEndpoints(existing, request)) {
      legs[request.id] = existing;
      if (optimize) {
        requests.push(request);
      }
    } else {
      legs[request.id] = airLeg(request);
      requests.push(request);
    }
  }

  return { legs, requests };
}

export function insertBetween(
  points: RoutePoint[],
  fromId: string,
  toId: string,
  inserted: RoutePoint,
): RoutePoint[] {
  const placed = points.filter(isPlaced);
  const index = placed.findIndex((point, position) => point.id === fromId && placed[position + 1]?.id === toId);
  if (index === -1) {
    throw new Error('Der gewählte Streckenabschnitt ist nicht mehr aktuell.');
  }
  const insertionIndex = points.findIndex((point) => point.id === toId);
  return [...points.slice(0, insertionIndex), inserted, ...points.slice(insertionIndex)];
}

export class LegScheduler {
  private active = new Map<string, { controller: AbortController; request: LegRequest; started: boolean }>();
  private running = new Set<AbortController>();
  private readonly routeLeg: RoutingEngine['routeLeg'];
  private readonly onResult: (request: LegRequest, leg: RouteLeg) => void;
  private readonly onError: (request: LegRequest, error: unknown) => void;
  private readonly onPending: (count: number) => void;

  constructor(
    routeLeg: RoutingEngine['routeLeg'],
    onResult: (request: LegRequest, leg: RouteLeg) => void,
    onError: (request: LegRequest, error: unknown) => void,
    onPending: (count: number) => void,
  ) {
    this.routeLeg = routeLeg;
    this.onResult = onResult;
    this.onError = onError;
    this.onPending = onPending;
  }

  update(legs: Record<string, RouteLeg>, requests: LegRequest[], optimize = false): void {
    for (const [id, operation] of this.active) {
      if (!legs[id] || !sameEndpoints(legs[id], operation.request)) {
        operation.controller.abort();
        this.active.delete(id);
      }
    }

    for (const request of requests) {
      const previous = this.active.get(request.id);
      if (previous && sameEndpoints(legs[request.id], previous.request) && !optimize) {
        continue;
      }
      previous?.controller.abort();

      const controller = new AbortController();
      this.active.set(request.id, { controller, request, started: false });
    }
    this.onPending(this.active.size);
    this.pump();
  }

  private pump(): void {
    for (const operation of this.active.values()) {
      if (this.running.size >= 2) break;
      if (operation.started) continue;
      operation.started = true;
      const { controller, request } = operation;
      this.running.add(controller);
      void Promise.resolve().then(() => this.routeLeg(request.fromCoord, request.toCoord, controller.signal))
        .then((geometry) => {
          if (this.active.get(request.id)?.controller !== controller) return;
          this.onResult(request, { ...request, ...geometry, status: 'routed' });
        })
        .catch((error: unknown) => {
          if (this.active.get(request.id)?.controller !== controller || controller.signal.aborted) return;
          this.onError(request, error);
          const message = error instanceof Error ? error.message : 'Die Strecke konnte nicht berechnet werden.';
          this.onResult(request, airLeg(request, message));
        })
        .finally(() => {
          this.running.delete(controller);
          if (this.active.get(request.id)?.controller === controller) {
            this.active.delete(request.id);
            this.onPending(this.active.size);
          }
          this.pump();
        });
    }
  }

  cancelAll(): void {
    for (const operation of this.active.values()) operation.controller.abort();
    this.active.clear();
    this.onPending(0);
  }
}

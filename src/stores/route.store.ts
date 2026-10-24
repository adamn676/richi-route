import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import type { FeatureCollection, LineString } from 'geojson';
import {
  airLeg,
  distanceMeters,
  insertBetween,
  isPlaced,
  legId,
  LegScheduler,
  reconcileLegs,
  sameEndpoints,
  type Coord,
  type LegRequest,
  type RouteLeg,
  type RoutePoint,
  type ShapePoint,
  type SurfaceSpan,
  type Waypoint,
} from '../domain/route-model.ts';
import { routingEngine } from '../services/route.service.ts';
import { forwardGeocode, type Place } from '../services/geocoding.service.ts';
import type { RouteDraft } from '../domain/route-draft.ts';
import { isRoutingPolicyCurrent } from '../config/routing-policy.ts';

export type { ShapePoint, Waypoint } from '../domain/route-model.ts';

interface RouteFeatureProperties {
  legId: string;
  fromId: string;
  toId: string;
  status: RouteLeg['status'];
  surfaces: SurfaceSpan[];
}

export type EditorRoute = FeatureCollection<LineString, RouteFeatureProperties>;
export type RouteFeature = EditorRoute['features'][number];

interface SurfaceFocus {
  leg: RouteLeg;
  fromIndex: number;
  toIndex: number;
}

interface HistoryEntry {
  points: RoutePoint[];
  legs: Record<string, RouteLeg>;
}

interface PendingOperations {
  scheduler: LegScheduler;
  snaps: Map<string, AbortController>;
  geocodes: Map<string, AbortController>;
}

const pending = new WeakMap<object, PendingOperations>();
// Legs are replaced as a unit, so one feature per leg lets the map skip unchanged legs by identity.
const legFeatures = new WeakMap<RouteLeg, RouteFeature>();
const routeFailureMessage = 'Routing fehlgeschlagen. Betroffene Abschnitte bleiben als gestrichelte Luftlinie sichtbar.';

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function waypoint(kind: Waypoint['kind'], coord: Coord | null = null): Waypoint {
  return {
    id: newId('stop'),
    type: 'stop',
    kind,
    coord,
    address: null,
    userInput: '',
    isGeocoding: false,
  };
}

function validCoord(coord: Coord): void {
  if (
    !Number.isFinite(coord[0]) ||
    !Number.isFinite(coord[1]) ||
    Math.abs(coord[0]) > 180 ||
    Math.abs(coord[1]) > 90
  ) {
    throw new Error('Bitte einen gültigen Punkt auf der Karte wählen.');
  }
}

function sameCoord(left: Coord, right: Coord): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function clonePoint(point: RoutePoint): RoutePoint {
  if (point.type === 'shape') return { ...point, coord: [...point.coord] };
  return {
    ...point,
    coord: point.coord ? [...point.coord] : null,
    isGeocoding: false,
  };
}

function snapshot(store: RouteStore): HistoryEntry {
  return { points: store.points.map(clonePoint), legs: { ...store.legs } };
}

function operationsFor(store: RouteStore): PendingOperations {
  // Devtools wrap actions in different store proxies; their state stays shared.
  const key = store.$state;
  let operations = pending.get(key);
  if (!operations) {
    operations = {
      snaps: new Map(),
      geocodes: new Map(),
      scheduler: new LegScheduler(
        (from, to, signal) => routingEngine.routeLeg(from, to, signal),
        (request, leg) => {
          const current = store.legs[request.id];
          if (!current || !sameEndpoints(current, request)) return;
          if (leg.status === 'routed') {
            const placed = store.points.filter(isPlaced);
            const endpoints = [
              { id: leg.fromId, coord: leg.coordinates[0], requested: leg.fromCoord, key: 'fromCoord' as const },
              { id: leg.toId, coord: leg.coordinates[leg.coordinates.length - 1], requested: leg.toCoord, key: 'toCoord' as const },
            ];
            const isOuter = (id: string) => id === placed[0].id || id === placed[placed.length - 1].id;
            if (endpoints.some(end => !isOuter(end.id) && distanceMeters(end.requested, end.coord) > 2)) {
              const message = 'Ein Abschnitt erreicht den Zwischenpunkt auf einem anderen Weg. Bitte diesen Punkt verschieben.';
              store.legs = { ...store.legs, [request.id]: airLeg(request, message) };
              store.errorMessage = message;
              return;
            }
            // Match outer endpoints in route context, preserving the user's original click.
            for (const end of endpoints.filter(end => isOuter(end.id))) {
              store.points = store.points.map(point => point.id === end.id ? { ...point, coord: [...end.coord], routingCoord: undefined } : point);
              leg[end.key] = [...end.coord];
            }
          }
          // Completed legs are replaced as a unit; their geometry stays immutable.
          store.legs = { ...store.legs, [request.id]: markRaw(leg) };
        },
        (_request, error) => {
          console.error('Streckenabschnitt konnte nicht berechnet werden:', error);
          store.errorMessage = error instanceof Error ? error.message : routeFailureMessage;
        },
        (count) => { store.pendingLegCount = count; },
      ),
    };
    pending.set(key, operations);
  }
  return operations;
}

function cancelRequests(store: RouteStore): void {
  const operations = operationsFor(store);
  for (const controller of operations.snaps.values()) controller.abort();
  for (const controller of operations.geocodes.values()) controller.abort();
  operations.snaps.clear();
  operations.geocodes.clear();
  operations.scheduler.cancelAll();
}

export const useRouteStore = defineStore('route', {
  state: () => ({
    points: [waypoint('start'), waypoint('end')] as RoutePoint[],
    legs: {} as Record<string, RouteLeg>,
    undoStack: [] as HistoryEntry[],
    redoStack: [] as HistoryEntry[],
    pendingLegCount: 0,
    errorMessage: null as string | null,
    draftStatus: 'idle' as 'idle' | 'saving' | 'saved' | 'restored' | 'error',
    draftError: null as string | null,
    surfaceFocus: null as SurfaceFocus | null,
  }),

  getters: {
    waypoints: (state): Waypoint[] => state.points.filter((point): point is Waypoint => point.type === 'stop'),
    shapingPoints: (state): ShapePoint[] => state.points.filter((point): point is ShapePoint => point.type === 'shape'),
    canUndo: (state): boolean => state.undoStack.length > 0,
    canRedo: (state): boolean => state.redoStack.length > 0,
    pendingSnapCount: (state): number => state.points.filter(point => point.snapPending).length,
    routingPending(): boolean { return this.pendingLegCount > 0 || this.pendingSnapCount > 0; },
    hasAirLines: (state): boolean => Object.values(state.legs).some((leg) => leg.status === 'air'),
    focusedSurface: (state) => {
      const focus = state.surfaceFocus;
      if (!focus || state.legs[focus.leg.id] !== focus.leg) return null;
      return { legId: focus.leg.id, fromIndex: focus.fromIndex, toIndex: focus.toIndex,
        coordinates: focus.leg.coordinates.slice(focus.fromIndex, focus.toIndex + 1) };
    },
    distanceMeters: (state): number => Object.values(state.legs).reduce((sum, leg) => sum + leg.distanceMeters, 0),
    ascentMeters: (state): number | null => {
      const legs = Object.values(state.legs);
      return legs.length > 0 && legs.every((leg) => leg.ascentMeters !== null)
        ? legs.reduce((sum, leg) => sum + (leg.ascentMeters ?? 0), 0)
        : null;
    },
    route: (state): EditorRoute | null => {
      const placed = state.points.filter(isPlaced);
      if (placed.length < 2) return null;
      return {
        type: 'FeatureCollection',
        features: placed.slice(0, -1).flatMap((from, index) => {
          const to = placed[index + 1];
          const leg = state.legs[legId(from.id, to.id)];
          if (!leg) return [];
          let feature = legFeatures.get(leg);
          if (!feature) {
            feature = {
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: leg.coordinates },
              properties: {
                legId: leg.id,
                fromId: leg.fromId,
                toId: leg.toId,
                status: leg.status,
                surfaces: leg.surfaces,
              },
            };
            legFeatures.set(leg, feature);
          }
          return [feature];
        }),
      };
    },
  },

  actions: {
    inspectSurface(legId: string, fromIndex: number, toIndex: number) {
      const leg = this.legs[legId];
      if (!leg || leg.status !== 'routed' || !Number.isInteger(fromIndex) || !Number.isInteger(toIndex) ||
          fromIndex < 0 || toIndex <= fromIndex || toIndex >= leg.coordinates.length) return;
      this.surfaceFocus = { leg: markRaw(leg), fromIndex, toIndex };
    },
    restoreDraft(draft: RouteDraft) {
      this.surfaceFocus = null;
      cancelRequests(this);
      this.points = draft.points;
      Object.values(draft.legs).forEach(markRaw);
      this.legs = draft.legs;
      this.undoStack = [];
      this.redoStack = [];
      this.errorMessage = this.points.find(p => p.snapError)?.snapError ??
        Object.values(this.legs).find(l => l.error)?.error ?? null;
      this._resumePendingSnaps();
      this._reconcile();
    },
    resetRoute(coords: Coord[] = [], shapeIndices: readonly number[] = []) {
      coords.forEach(validCoord);
      if (shapeIndices.some(index => !Number.isInteger(index) || index <= 0 || index >= coords.length - 1)) {
        throw new Error('Formpunkte müssen zwischen Start und Ziel liegen.');
      }
      this._remember();
      cancelRequests(this);
      this.points = coords.length >= 2
        ? coords.map((coord, index): RoutePoint => shapeIndices.includes(index)
          ? { id: newId('shape'), type: 'shape', coord: [...coord] }
          : waypoint(index === 0 ? 'start' : index === coords.length - 1 ? 'end' : 'via', [...coord]))
        : [waypoint('start'), waypoint('end')];
      this.legs = {};
      for (const point of this.points) if (point.coord) this._snapPoint(point.id, point.coord);
      this._reconcile();
    },
    _remember() {
      this.surfaceFocus = null;
      this.undoStack = [...this.undoStack.slice(-49), snapshot(this)];
      this.redoStack = [];
      this.errorMessage = null;
    },

    _reconcile(optimize = false) {
      const operations = operationsFor(this);
      const result = reconcileLegs(this.points, this.legs, optimize);
      this.legs = result.legs;
      const candidates: LegRequest[] = optimize
        ? result.requests
        : Object.values(result.legs)
            .filter((leg) =>
              (leg.status === 'air' || !isRoutingPolicyCurrent(leg.routingPolicy)) &&
              !leg.error &&
              !operations.snaps.has(leg.fromId) &&
              !operations.snaps.has(leg.toId))
            .map(({ id, fromId, toId, fromCoord, toCoord }) => ({
              id, fromId, toId, fromCoord, toCoord,
            }));
      const requests = candidates.filter(leg => [leg.fromId, leg.toId].every(id => {
        const point = this.points.find(point => point.id === id);
        return point && !point.snapPending && !point.snapError;
      }));
      operations.scheduler.update(this.legs, requests, optimize);
    },

    _snapPoint(id: string, coord: Coord) {
      const operations = operationsFor(this);
      operations.snaps.get(id)?.abort();
      operations.geocodes.get(id)?.abort();
      operations.geocodes.delete(id);
      const controller = new AbortController();
      operations.snaps.set(id, controller);
      this.points = this.points.map(point => point.id === id ? {
        ...point, snapPending: true, snapError: undefined,
        ...(point.type === 'stop' && point.kind !== 'via' ? { routingCoord: coord } : {}),
      } : point);

      void routingEngine.snap(coord, controller.signal)
        .then((snapped) => {
          if (operations.snaps.get(id) !== controller) return;
          validCoord(snapped);
          const current = this.points.find((point) => point.id === id);
          if (current?.coord && sameCoord(current.coord, coord)) {
            this.points = this.points.map((point) =>
              point.id === id ? { ...point, coord: [...snapped] } : point);
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || operations.snaps.get(id) !== controller) return;
          console.error('Straßen-Snapping fehlgeschlagen:', error);
          const message = error instanceof Error ? error.message : 'Kein geeigneter Straßenpunkt gefunden.';
          this.points = this.points.map(point => point.id === id ? { ...point, snapError: message } : point);
          this.errorMessage = message;
        })
        .finally(() => {
          if (operations.snaps.get(id) !== controller) return;
          operations.snaps.delete(id);
          this.points = this.points.map(point => point.id === id ? { ...point, snapPending: false } : point);
          this._reconcile();
        });
    },

    addWaypointByClick(coord: Coord) {
      validCoord(coord);
      const target =
        this.waypoints.find((point) => point.kind === 'start' && !point.coord) ??
        this.waypoints.find((point) => point.kind === 'end' && !point.coord) ??
        this.waypoints.filter((point) => point.kind === 'via' && !point.coord).pop();
      if (target) {
        this.updateWaypointCoord(target.id, coord);
        return;
      }
      const stop = waypoint('via', [...coord]);
      const endIndex = this.points.findIndex((point) => point.type === 'stop' && point.kind === 'end');
      this._remember();
      this.points = [...this.points.slice(0, endIndex), stop, ...this.points.slice(endIndex)];
      this._snapPoint(stop.id, coord);
      this._reconcile();
    },

    addIntermediateStopAndPrepare(): string {
      const endIndex = this.points.findIndex((point) => point.type === 'stop' && point.kind === 'end');
      const stop = waypoint('via');
      this._remember();
      this.points = [...this.points.slice(0, endIndex), stop, ...this.points.slice(endIndex)];
      this._reconcile();
      return stop.id;
    },

    insertWaypointOnRoute(fromId: string, toId: string, coord: Coord) {
      validCoord(coord);
      const stop = waypoint('via', [...coord]);
      const updated = insertBetween(this.points, fromId, toId, stop);
      this._remember();
      this.points = updated;
      this._snapPoint(stop.id, coord);
      this._reconcile();
    },

    insertShapingPoint(fromId: string, toId: string, coord: Coord) {
      validCoord(coord);
      const shape: ShapePoint = { id: newId('shape'), type: 'shape', coord: [...coord] };
      const updated = insertBetween(this.points, fromId, toId, shape);
      this._remember();
      this.points = updated;
      this._snapPoint(shape.id, coord);
      this._reconcile();
    },

    updateWaypointCoord(id: string, coord: Coord, address: string | null = null) {
      validCoord(coord);
      const current = this.waypoints.find((point) => point.id === id);
      if (!current) throw new Error('Der ausgewählte Stopp existiert nicht mehr.');
      if (current.coord && sameCoord(current.coord, coord) && current.address === address) return;
      this._remember();
      this.points = this.points.map((point) =>
        point.id === id && point.type === 'stop'
          ? { ...point, coord: [...coord], address, userInput: address ?? '', isGeocoding: false }
          : point);
      this._snapPoint(id, coord);
      this._reconcile();
    },

    updateShapingPointCoord(id: string, coord: Coord) {
      validCoord(coord);
      const current = this.shapingPoints.find((point) => point.id === id);
      if (!current) throw new Error('Der Formpunkt existiert nicht mehr.');
      if (sameCoord(current.coord, coord)) return;
      this._remember();
      this.points = this.points.map((point) =>
        point.id === id && point.type === 'shape' ? { ...point, coord: [...coord] } : point);
      this._snapPoint(id, coord);
      this._reconcile();
    },

    setWaypointQuery(id: string, text: string) {
      const stop = this.waypoints.find((point) => point.id === id);
      if (!stop) throw new Error('Der ausgewählte Stopp existiert nicht mehr.');
      const operations = operationsFor(this);
      operations.geocodes.get(id)?.abort();
      operations.geocodes.delete(id);
      this.points = this.points.map((point) =>
        point.id === id && point.type === 'stop'
          ? { ...point, userInput: text, isGeocoding: false }
          : point);
    },

    setWaypointPlace(id: string, place: Place) {
      if (!place.label.trim()) throw new Error('Der Adressvorschlag enthält keine Bezeichnung.');
      this.updateWaypointCoord(id, place.coord, place.label);
    },

    async searchAndSetWaypointAddress(id: string, query: string): Promise<void> {
      const trimmed = query.trim();
      if (trimmed.length < 3) throw new Error('Bitte mindestens drei Zeichen eingeben.');
      const stop = this.waypoints.find((point) => point.id === id);
      if (!stop) throw new Error('Der ausgewählte Stopp existiert nicht mehr.');
      const operations = operationsFor(this);
      operations.geocodes.get(id)?.abort();
      const controller = new AbortController();
      operations.geocodes.set(id, controller);
      this.points = this.points.map((point) =>
        point.id === id && point.type === 'stop'
          ? { ...point, userInput: trimmed, isGeocoding: true }
          : point);
      try {
        const places = await forwardGeocode(trimmed, controller.signal);
        if (operations.geocodes.get(id) !== controller) return;
        const current = this.waypoints.find((point) => point.id === id);
        if (current?.userInput !== trimmed) return;
        if (!places.length) throw new Error(`Keine Adresse für „${trimmed}“ gefunden.`);
        this.setWaypointPlace(id, places[0]);
      } catch (error) {
        if (controller.signal.aborted || operations.geocodes.get(id) !== controller) return;
        console.error('Adresssuche fehlgeschlagen:', error);
        this.errorMessage = error instanceof Error ? error.message : 'Adresssuche fehlgeschlagen.';
      } finally {
        if (operations.geocodes.get(id) === controller) {
          operations.geocodes.delete(id);
          this.points = this.points.map((point) =>
            point.id === id && point.type === 'stop' ? { ...point, isGeocoding: false } : point);
        }
      }
    },

    moveWaypoint(id: string, direction: -1 | 1) {
      const via = this.waypoints.filter((point) => point.kind === 'via');
      const index = via.findIndex((point) => point.id === id);
      const other = via[index + direction];
      if (index === -1 || !other) throw new Error('Der Stopp kann nicht weiter verschoben werden.');
      const firstIndex = this.points.findIndex((point) => point.id === id);
      const secondIndex = this.points.findIndex((point) => point.id === other.id);
      const updated = [...this.points];
      [updated[firstIndex], updated[secondIndex]] = [updated[secondIndex], updated[firstIndex]];
      this._remember();
      this.points = updated;
      this._reconcile();
    },

    removeWaypoint(id: string) {
      const stop = this.waypoints.find((point) => point.id === id);
      if (!stop || stop.kind !== 'via') throw new Error('Nur Zwischenstopps können gelöscht werden.');
      this._remember();
      const operations = operationsFor(this);
      operations.snaps.get(id)?.abort();
      operations.snaps.delete(id);
      operations.geocodes.get(id)?.abort();
      operations.geocodes.delete(id);
      this.points = this.points.filter((point) => point.id !== id);
      this._reconcile();
    },

    clearShaping() {
      if (!this.shapingPoints.length) return;
      this._remember();
      const operations = operationsFor(this);
      for (const shape of this.shapingPoints) {
        operations.snaps.get(shape.id)?.abort();
        operations.snaps.delete(shape.id);
      }
      this.points = this.points.filter((point) => point.type === 'stop');
      this._reconcile();
    },

    optimizeEntireRoute() {
      if (!Object.keys(this.legs).length) throw new Error('Bitte zuerst Start und Ziel setzen.');
      this._remember();
      this._reconcile(true);
    },

    retryRouting() {
      this.errorMessage = null;
      for (const point of this.points) {
        if (point.coord && point.snapError) this._snapPoint(point.id, point.coord);
      }
      this.legs = Object.fromEntries(Object.entries(this.legs).map(([id, leg]) => [id, leg.error ? { ...leg, error: undefined } : leg]));
      this._reconcile();
    },

    _resumePendingSnaps() {
      for (const point of this.points) {
        if (point.coord && point.snapPending) this._snapPoint(point.id, point.coord);
      }
    },

    undo() {
      const previous = this.undoStack[this.undoStack.length - 1];
      if (!previous) return;
      this.surfaceFocus = null;
      this.undoStack = this.undoStack.slice(0, -1);
      this.redoStack = [...this.redoStack, snapshot(this)];
      cancelRequests(this);
      this.points = previous.points.map(clonePoint);
      this.legs = { ...previous.legs };
      this.errorMessage = null;
      this._resumePendingSnaps();
      this._reconcile();
    },

    redo() {
      const next = this.redoStack[this.redoStack.length - 1];
      if (!next) return;
      this.surfaceFocus = null;
      this.redoStack = this.redoStack.slice(0, -1);
      this.undoStack = [...this.undoStack, snapshot(this)];
      cancelRequests(this);
      this.points = next.points.map(clonePoint);
      this.legs = { ...next.legs };
      this.errorMessage = null;
      this._resumePendingSnaps();
      this._reconcile();
    },
  },
});

export type RouteStore = ReturnType<typeof useRouteStore>;

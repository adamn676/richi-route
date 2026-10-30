import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import type { FeatureCollection, LineString } from 'geojson';
import {
  airLeg,
  distanceMeters,
  insertBetween,
  isOutdated,
  isPlaced,
  legId,
  LegScheduler,
  pathMeters,
  PlacementError,
  reconcileLegs,
  SectionError,
  sameEndpoints,
  type Coord,
  type LegGeometry,
  type LegRequest,
  type RouteLeg,
  type RoutePoint,
  type ShapePoint,
  type Surface,
  type SurfaceSpan,
  type Waypoint,
} from '../domain/route-model.ts';
import { routingEngine } from '../services/route.service.ts';
import { forwardGeocode, reverseGeocode, type Place } from '../services/geocoding.service.ts';
import { pointOnStreet } from '../services/street-point.service.ts';
import type { RouteDraft } from '../domain/route-draft.ts';
import type { GpxTrack } from '../domain/gpx-track.ts';
import { sectionSurfaces, type GpxSection } from '../domain/gpx-route.ts';
import { loopSections } from '../domain/loop-suggestions.ts';
import { lookupGpxSurfaces } from '../services/gpx-surfaces.service.ts';
import { saveSurfaceReport } from '../services/surface-corrections.service.ts';
import { applyReport, osmSurfaces, type CorrectedSurface } from '../domain/surface-corrections.ts';
import { inspectStretch, type SurfaceSection } from '../domain/route-surfaces.ts';

export type { ShapePoint, Waypoint } from '../domain/route-model.ts';

interface RouteFeatureProperties {
  legId: string;
  fromId: string;
  toId: string;
  status: RouteLeg['status'];
  // A straight leg still being calculated, rather than one that failed.
  waiting: boolean;
  surfaces: SurfaceSpan[];
}

export type EditorRoute = FeatureCollection<LineString, RouteFeatureProperties>;
export type RouteFeature = EditorRoute['features'][number];

interface SurfaceFocus {
  id: string;
  parts: { leg: RouteLeg; fromIndex: number; toIndex: number }[];
  surface: Surface;
}

// A stretch of a planned leg whose surface the rider reports: its start, then its end, tapped on the map; until the
// end is tapped, the stretch follows the pointer.
interface SurfacePick {
  leg: RouteLeg;
  start: number;
  end: number | null;
  hover: number | null;
}

interface HistoryEntry {
  points: RoutePoint[];
  legs: Record<string, RouteLeg>;
}

interface PendingOperations {
  scheduler: LegScheduler;
  snaps: Map<string, AbortController>;
  geocodes: Map<string, AbortController>;
  surfaces?: AbortController;
}

const pending = new WeakMap<object, PendingOperations>();
// Legs are replaced as a unit, so one feature per leg lets the map skip unchanged legs by identity.
const legFeatures = new WeakMap<RouteLeg, RouteFeature>();
const routeFailureMessage = 'Routing fehlgeschlagen. Betroffene Abschnitte bleiben als rot gestrichelte Luftlinie sichtbar.';

// Straight legs the engine is still to answer: neither failed nor waiting for a stop that found no street.
function waitingTest(points: RoutePoint[]): (leg: RouteLeg) => boolean {
  const unsnapped = new Set(points.filter(point => point.snapError).map(point => point.id));
  return leg => leg.status === 'air' && !leg.error && !unsnapped.has(leg.fromId) && !unsnapped.has(leg.toId);
}

function legFeature(leg: RouteLeg, waiting: boolean): RouteFeature {
  let feature = legFeatures.get(leg);
  if (!feature || feature.properties.waiting !== waiting) {
    feature = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: leg.coordinates },
      properties: { legId: leg.id, fromId: leg.fromId, toId: leg.toId, status: leg.status, waiting, surfaces: leg.surfaces },
    };
    legFeatures.set(leg, feature);
  }
  return feature;
}

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
              const message = 'Dieser Zwischenpunkt liegt zwischen zwei Straßen. Bitte ihn direkt auf die gewünschte Straße ziehen.';
              store.legs = { ...store.legs, [request.id]: airLeg(request, message) };
              store.errorMessage = message;
              store.errorSection = { message, legId: request.id };
              store._settleFormerLegs();
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
          store._settleFormerLegs();
        },
        (request, error) => {
          console.error('Streckenabschnitt konnte nicht berechnet werden:', error);
          store.errorMessage = error instanceof Error ? error.message : routeFailureMessage;
          if (error instanceof SectionError) store.errorSection = { message: error.message, legId: request.id };
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
  store.formerLegs = [];
  for (const controller of operations.snaps.values()) controller.abort();
  for (const controller of operations.geocodes.values()) controller.abort();
  operations.snaps.clear();
  operations.geocodes.clear();
  operations.scheduler.cancelAll();
  operations.surfaces?.abort();
  operations.surfaces = undefined;
  store.surfaceEstimate = null;
}

export const useRouteStore = defineStore('route', {
  state: () => ({
    points: [waypoint('start'), waypoint('end')] as RoutePoint[],
    legs: {} as Record<string, RouteLeg>,
    // The routed legs an edit replaced, shown faded while their successors are calculated.
    formerLegs: [] as RouteLeg[],
    undoStack: [] as HistoryEntry[],
    redoStack: [] as HistoryEntry[],
    pendingLegCount: 0,
    errorMessage: null as string | null,
    // The section a routing error belongs to, while that error shows.
    errorSection: null as { message: string; legId: string } | null,
    // The section the map frames, on request.
    shownSection: null as { legId: string } | null,
    draftStatus: 'idle' as 'idle' | 'saving' | 'saved' | 'restored' | 'error',
    // Set once the saved draft has been looked for, whether one was found or not.
    draftLoaded: false,
    draftError: null as string | null,
    surfaceFocus: null as SurfaceFocus | null,
    surfaceReporting: false,
    surfacePick: null as SurfacePick | null,
    // Progress of looking up the surfaces of an imported GPX track.
    surfaceEstimate: null as { completed: number; total: number } | null,
    // Counts routes opened as a whole (examples, saved routes, imports) and the stops found by address that start or
    // complete a route; the map then shows the route, or the first stop alone.
    fitRequest: 0,
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
      if (!focus?.parts.every(part => state.legs[part.leg.id] === part.leg)) return null;
      return { id: focus.id, surface: focus.surface,
        coordinates: focus.parts.flatMap(part => part.leg.coordinates.slice(part.fromIndex, part.toIndex + 1)) };
    },
    // A pick lasts while reporting goes on and its leg stays as it is.
    surfacePicking: (state): SurfacePick | null => {
      const pick = state.surfacePick;
      return state.surfaceReporting && pick && state.legs[pick.leg.id] === pick.leg ? pick : null;
    },
    surfacePreview(): { coordinates: Coord[]; surface: Surface } | null {
      const pick = this.surfacePicking;
      if (!pick) return null;
      const end = pick.end ?? pick.hover ?? pick.start, from = Math.min(pick.start, end), to = Math.max(pick.start, end);
      const { surfaces } = inspectStretch(pick.leg, from, to);
      return { coordinates: pick.leg.coordinates.slice(from, to + 1), surface: surfaces.length === 1 ? surfaces[0] : 'unknown' };
    },
    // The stretch to report, once its end is tapped.
    surfaceSelection(): { leg: RouteLeg; fromIndex: number; toIndex: number; meters: number; surfaces: Surface[]; corrected: boolean } | null {
      const pick = this.surfacePicking;
      if (pick?.end == null) return null;
      const fromIndex = Math.min(pick.start, pick.end), toIndex = Math.max(pick.start, pick.end);
      return { leg: pick.leg, fromIndex, toIndex, meters: pathMeters(pick.leg.coordinates.slice(fromIndex, toIndex + 1)),
        ...inspectStretch(pick.leg, fromIndex, toIndex) };
    },
    // Only planned legs have their roads' surfaces; recorded tracks lie beside them. Reports are saved by the planner's
    // development server (scripts/surface-corrections.ts), which a built planner lacks.
    surfacesReportable: (state): boolean => Boolean(import.meta.env?.DEV) &&
      Object.values(state.legs).some(leg => leg.status === 'routed' && !leg.recorded),
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
      const waiting = waitingTest(state.points);
      return {
        type: 'FeatureCollection',
        features: placed.slice(0, -1).flatMap((from, index) => {
          const leg = state.legs[legId(from.id, placed[index + 1].id)];
          return leg ? [legFeature(leg, waiting(leg))] : [];
        }),
      };
    },
    formerRoute: (state): RouteFeature[] => state.formerLegs.map(leg => legFeature(leg, false)),
    // What the panel reports for the whole route: an error, or sections that failed before; a section's own problem
    // offers to show it, any other a retry.
    routeProblem(): { message: string; section: string | null; retry: boolean } | null {
      if (this.errorMessage) {
        const legId = this.errorSection?.message === this.errorMessage ? this.errorSection.legId : null;
        const section = legId && this.legs[legId]?.error ? legId : null;
        return { message: this.errorMessage, section, retry: !section };
      }
      const failed = Object.values(this.legs).find(leg => leg.error);
      return failed && !this.routingPending ? { message: 'Rot gestrichelte Abschnitte konnten nicht berechnet werden.', section: failed.id, retry: true } : null;
    },
    // Why a stop has no street, if moving it is the fix: its row says so and it shows red. Problems fixed elsewhere (the
    // service, missing map data) are the panel's, with a retry.
    stopError: (state) => (point: RoutePoint): string | undefined => point.snapError !== state.errorMessage ? point.snapError : undefined,
  },

  actions: {
    showSection(legId: string) {
      this.shownSection = { legId };
    },
    inspectSurface({ id, parts, surface }: Pick<SurfaceSection, 'id' | 'parts' | 'surface'>) {
      const focused: SurfaceFocus['parts'] = [];
      for (const { legId, fromIndex, toIndex } of parts) {
        const leg = this.legs[legId];
        if (!leg || leg.status !== 'routed' || !Number.isInteger(fromIndex) || !Number.isInteger(toIndex) ||
            fromIndex < 0 || toIndex <= fromIndex || toIndex >= leg.coordinates.length) return;
        focused.push({ leg: markRaw(leg), fromIndex, toIndex });
      }
      if (focused.length) this.surfaceFocus = { id, parts: focused, surface };
    },
    setSurfaceReporting(on: boolean) {
      this.surfaceReporting = on;
      this.surfacePick = null;
      if (on) this.surfaceFocus = null;
    },
    // A tapped vertex: it starts a stretch, or ends the one started on the same leg. Recorded tracks lie beside the
    // roads and cannot be reported.
    pickSurfacePoint(legId: string, index: number) {
      const leg = this.legs[legId], pick = this.surfacePicking;
      if (!this.surfaceReporting || !leg || leg.status !== 'routed' || leg.recorded) return;
      if (pick && pick.end === null) {
        if (pick.leg === leg && index !== pick.start) pick.end = index;
        return;
      }
      this.surfacePick = { leg: markRaw(leg), start: index, end: null, hover: null };
    },
    hoverSurfacePoint(index: number | null) {
      if (this.surfacePicking?.end === null) this.surfacePicking.hover = index;
    },
    // Saves the rider's surface for the selected stretch, or the map's again (null). The routing engine uses it from
    // its next answer on; the route shows it at once, also in the undo history, since the saved report stays.
    async reportSurface(surface: CorrectedSurface | null) {
      const selection = this.surfaceSelection;
      if (!selection) return;
      const { leg, fromIndex, toIndex } = selection, points = leg.coordinates.slice(fromIndex, toIndex + 1);
      await saveSurfaceReport({ points, surface, osmSurfaces: osmSurfaces(leg, fromIndex, toIndex) });
      const memo = new Map<RouteLeg, RouteLeg>();
      const relabel = (legs: Record<string, RouteLeg>) => {
        const relabelled = applyReport(legs, { points, surface }, memo);
        Object.values(relabelled).forEach(markRaw);
        return relabelled;
      };
      this.legs = relabel(this.legs);
      this.undoStack = this.undoStack.map(entry => ({ ...entry, legs: relabel(entry.legs) }));
      this.redoStack = this.redoStack.map(entry => ({ ...entry, legs: relabel(entry.legs) }));
      this.surfacePick = null;
    },
    restoreDraft(draft: RouteDraft) {
      this.surfaceFocus = null;
      cancelRequests(this);
      this.points = draft.points;
      Object.values(draft.legs).forEach(markRaw);
      this.legs = draft.legs;
      this.undoStack = [];
      this.redoStack = [];
      this.errorMessage = this.points.find(p => p.type === 'shape' && p.snapError)?.snapError ??
        Object.values(this.legs).find(l => l.error)?.error ?? null;
      this._resumePendingSnaps();
      this._reconcile();
      // Routes saved before stops were named get their street names now.
      for (const stop of this.waypoints) this._nameStop(stop.id);
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
      if (coords.length) this.fitRequest++;
    },
    // Replaces the route with a GPX track; surfaces are looked up afterwards.
    importTrack(track: GpxTrack, sections: GpxSection[][]) {
      void this._lookupSurfaces(track, this._openSections(sections));
    },
    // Shows a suggested loop as the route; it already has its surfaces. Trying another loop replaces it without a
    // further undo step. The suggestions keep the map's view, so the loops stay comparable.
    openLoop(loop: LegGeometry, replace = false) {
      this._openSections([loopSections(loop)], { remember: !replace, fit: false });
    },
    // Replaces the route with fixed sections, as one undoable step: start and end stops with shaping points between
    // the sections. Gaps between segments get routed.
    _openSections<T extends LegGeometry>(segments: T[][], { remember = true, fit = true } = {}): { leg: RouteLeg; section: T }[] {
      if (remember) this._remember();
      else { this.surfaceFocus = null; this.errorMessage = null; }
      cancelRequests(this);
      const stops: { coord: Coord; section?: T }[] = [];
      for (const segment of segments) {
        const start = segment[0].coordinates[0];
        if (!stops.length || !sameCoord(stops[stops.length - 1].coord, start)) stops.push({ coord: start });
        for (const section of segment) stops.push({ coord: section.coordinates[section.coordinates.length - 1], section });
      }
      this.points = stops.map((stop, i): RoutePoint => i === 0 ? waypoint('start', [...stop.coord])
        : i === stops.length - 1 ? waypoint('end', [...stop.coord]) : { id: newId('shape'), type: 'shape', coord: [...stop.coord] });
      const legs: Record<string, RouteLeg> = {};
      const opened: { leg: RouteLeg; section: T }[] = [];
      stops.forEach((stop, i) => {
        if (!stop.section) return;
        const from = this.points[i - 1] as RoutePoint & { coord: Coord }, to = this.points[i] as RoutePoint & { coord: Coord };
        const { coordinates, elevations, distanceMeters, ascentMeters, surfaces, routingPolicy, recorded } = stop.section;
        const leg = markRaw<RouteLeg>({ coordinates, elevations, distanceMeters, ascentMeters, surfaces, routingPolicy, ...(recorded ? { recorded } : {}),
          id: legId(from.id, to.id), fromId: from.id, toId: to.id, fromCoord: from.coord, toCoord: to.coord, status: 'routed' });
        legs[leg.id] = leg;
        opened.push({ leg, section: stop.section });
      });
      this.legs = legs;
      this.errorMessage = null;
      this._reconcile();
      for (const stop of this.waypoints) this._nameStop(stop.id);
      if (fit) this.fitRequest++;
      return opened;
    },
    async _lookupSurfaces(track: GpxTrack, imported: { leg: RouteLeg; section: GpxSection }[]) {
      const operations = operationsFor(this);
      const controller = new AbortController();
      operations.surfaces = controller;
      this.surfaceEstimate = { completed: 0, total: 0 };
      try {
        const { surfaces } = await lookupGpxSurfaces(track, controller.signal, (completed, total) => {
          if (operations.surfaces === controller) this.surfaceEstimate = { completed, total };
        });
        // Legs edited in the meantime keep their own surfaces.
        const legs = { ...this.legs };
        let found = false;
        for (const { leg, section } of imported) {
          const spans = sectionSurfaces(section, surfaces[section.segment]);
          if (spans.length && legs[leg.id] === leg) { legs[leg.id] = markRaw({ ...leg, surfaces: spans }); found = true; }
        }
        if (found) this.legs = legs;
      } catch { /* Cancelled by a route change; surfaces stay unknown. */ }
      finally {
        if (operations.surfaces === controller) { operations.surfaces = undefined; this.surfaceEstimate = null; }
      }
    },

    _remember() {
      this.surfaceFocus = null;
      this.undoStack = [...this.undoStack.slice(-49), snapshot(this)];
      this.redoStack = [];
      this.errorMessage = null;
    },

    _settleFormerLegs() {
      if (this.formerLegs.length && !Object.values(this.legs).some(waitingTest(this.points))) this.formerLegs = [];
    },

    _reconcile(optimize = false) {
      const operations = operationsFor(this);
      const result = reconcileLegs(this.points, this.legs, optimize);
      const kept = new Set(Object.values(result.legs));
      const replaced = Object.values(this.legs).filter(leg => leg.status === 'routed' && !kept.has(leg));
      this.formerLegs = [...this.formerLegs.filter(leg => !kept.has(leg)), ...replaced];
      this.legs = result.legs;
      this._settleFormerLegs();
      const candidates: LegRequest[] = optimize
        ? result.requests
        : Object.values(result.legs)
            .filter((leg) =>
              (leg.status === 'air' || isOutdated(leg)) &&
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

    // A stop placed on the map gets the street it lies on, without an undo step.
    // Typing or moving the stop cancels the lookup, like a search.
    _nameStop(id: string) {
      const operations = operationsFor(this);
      const stop = this.waypoints.find((point) => point.id === id);
      if (!stop?.coord || stop.address !== null || stop.userInput || operations.geocodes.has(id)) return;
      const controller = new AbortController();
      operations.geocodes.set(id, controller);
      void reverseGeocode(stop.coord, controller.signal)
        .then((label) => {
          if (!label || operations.geocodes.get(id) !== controller) return;
          this.points = this.points.map((point) => point.id === id && point.type === 'stop' && point.address === null && !point.userInput
            ? { ...point, address: label, userInput: label } : point);
        })
        .catch(() => { /* Without the address service, the position stays shown. */ })
        .finally(() => { if (operations.geocodes.get(id) === controller) operations.geocodes.delete(id); });
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
          // A stop shows its own problem in its row; the service's problems, and a shaping point's, which has no row, show
          // in the panel.
          if (!(error instanceof PlacementError) || this.points.find(point => point.id === id)?.type === 'shape') this.errorMessage = message;
        })
        .finally(() => {
          if (operations.snaps.get(id) !== controller) return;
          operations.snaps.delete(id);
          this.points = this.points.map(point => point.id === id ? { ...point, snapPending: false } : point);
          this._reconcile();
          this._nameStop(id);
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
      // A further click extends the route: it becomes the destination, and the old one a stop on the way.
      const stop = waypoint('end', [...coord]);
      this._remember();
      this.points = [...this.points.map((point): RoutePoint => point.type === 'stop' && point.kind === 'end' ? { ...point, kind: 'via' } : point), stop];
      this._snapPoint(stop.id, coord);
      this._reconcile();
    },

    // The field's clear button takes the stop's point too, as one undoable step. A start or destination also takes the
    // shaping points of its section, which would otherwise begin or end the route.
    clearWaypoint(id: string) {
      const index = this.points.findIndex((point) => point.id === id);
      const stop = this.points[index];
      if (stop?.type !== 'stop') throw new Error('Der ausgewählte Stopp existiert nicht mehr.');
      if (!stop.coord) { this.setWaypointQuery(id, ''); return; }
      let from = index, to = index;
      if (stop.kind !== 'via') {
        while (this.points[from - 1]?.type === 'shape') from--;
        while (this.points[to + 1]?.type === 'shape') to++;
      }
      this._remember();
      const operations = operationsFor(this);
      for (const point of this.points.slice(from, to + 1)) {
        operations.snaps.get(point.id)?.abort();
        operations.snaps.delete(point.id);
      }
      operations.geocodes.get(id)?.abort();
      operations.geocodes.delete(id);
      this.points = [...this.points.slice(0, from), { ...waypoint(stop.kind), id }, ...this.points.slice(to + 1)];
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

    // An address starts on its own street: its centre can lie nearer a path behind it, such as a park.
    async setWaypointPlace(id: string, place: Place) {
      if (!place.label.trim()) throw new Error('Der Adressvorschlag enthält keine Bezeichnung.');
      const before = this.waypoints.find((point) => point.id === id);
      const coord = place.street
        ? await pointOnStreet(place.coord, place.street, AbortSignal.timeout(3000)).catch(() => null) ?? place.coord : place.coord;
      // Typed over or moved in the meantime: the newer input wins.
      const current = this.waypoints.find((point) => point.id === id);
      if (!current || current.coord !== before?.coord || current.userInput !== before?.userInput) return;
      // Later edits keep the view, so a stop being added does not move the map or fold the phone sheet.
      const complete = Boolean(this.route);
      this.updateWaypointCoord(id, coord, place.label);
      if (!complete) this.fitRequest++;
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
        await this.setWaypointPlace(id, places[0]);
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

    // The intermediate stop to another place among them, as one step; shaping points stay where they are.
    moveWaypointTo(id: string, to: number) {
      const slots = this.points.flatMap((point, i) => point.type === 'stop' && point.kind === 'via' ? [i] : []);
      const order = slots.map((slot) => this.points[slot]);
      const from = order.findIndex((point) => point.id === id);
      if (from === -1 || to < 0 || to >= order.length) throw new Error('Der Stopp kann nicht weiter verschoben werden.');
      if (from === to) return;
      order.splice(to, 0, ...order.splice(from, 1));
      const updated = [...this.points];
      slots.forEach((slot, i) => { updated[slot] = order[i]; });
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

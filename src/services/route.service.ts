import { distanceMeters, PlacementError, routingConcurrency, SectionError, type Coord, type LegGeometry, type RoutingEngine } from '../domain/route-model.ts';
import type { LoopTarget } from '../domain/loop-suggestions.ts';
import { routingProfile, routingParameters, routingPolicyVersion } from '../config/routing-policy.ts';

const maxSnapDistance = 250;
const unavailableMessage = 'Der lokale Routing-Dienst ist nicht erreichbar. Bitte den Routing-Dienst starten und erneut versuchen.';
// In the browser, routes need the routing service; offline areas bring the map and the address search.
const offlineMessage = 'Ohne Netz berechnet der Planer im Browser keine Route. Karte und Adresssuche der Offline-Gebiete gehen weiter.';
const timeoutMessage = 'Die Routenberechnung hat das Zeitlimit erreicht. Bitte einen Zwischenstopp dazwischen setzen.';
const waiting: (() => void)[] = [];
const backgroundWaiting: (() => void)[] = [];
let active = 0;

function pump(): void {
  while (active < routingConcurrency && (waiting.length || backgroundWaiting.length)) {
    (waiting.length ? waiting : backgroundWaiting).shift()!();
  }
}

function withSlot<T>(signal: AbortSignal, work: () => Promise<T>, background = false): Promise<T> {
  const queue = background ? backgroundWaiting : waiting;
  return new Promise((resolve, reject) => {
    const cancel = () => {
      const index = queue.indexOf(start);
      if (index >= 0) queue.splice(index, 1);
      signal.removeEventListener('abort', cancel);
      reject(signal.reason);
    };
    const start = () => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) { reject(signal.reason); return; }
      active++;
      void Promise.resolve().then(work).then(resolve, reject).finally(() => { active--; pump(); });
    };
    if (signal.aborted) { reject(signal.reason); return; }
    queue.push(start);
    signal.addEventListener('abort', cancel, { once: true });
    pump();
  });
}

// The routing service's response, or the error to show when it gives none.
async function reach(fetching: () => Promise<Response>, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetching();
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof Error && error.name === 'TimeoutError') throw new SectionError(timeoutMessage, { cause: error });
    throw new Error(navigator.onLine === false ? offlineMessage : unavailableMessage, { cause: error });
  }
}

// The routing service's answer as JSON, or the error to show for it.
async function answer(fetching: () => Promise<Response>, signal: AbortSignal): Promise<unknown> {
  const response = await reach(fetching, signal);
  if (!response.ok) {
    const detail = (await response.text()).trim();
    if (detail === 'local routing rules version mismatch') throw new Error('Die lokalen Routing-Regeln wurden geändert. Bitte den Routing-Dienst neu starten.');
    const missingTile = /^datafile ([EW]\d+_[NS]\d+\.rd5) not found$/.exec(detail);
    if (missingTile) throw new Error(`Für diese Gegend fehlen lokale Kartendaten (${missingTile[1]}). Bitte die Kartendaten ergänzen und den Routing-Dienst neu starten.`);
    if (/timeout after \d+ seconds|operation killed by thread-priority-watchdog/.test(detail)) throw new SectionError(timeoutMessage);
    if (detail === 'memory limit reached') throw new SectionError('Die Routenberechnung hat das Speicherlimit erreicht, der Abschnitt ist zu weit. Bitte einen Zwischenstopp dazwischen setzen.');
    if (/^no track found\b|position not mapped in existing datafile/.test(detail)) throw new PlacementError('Keine passende Fahrradverbindung gefunden. Bitte Start, Ziel oder Zwischenpunkte verschieben.');
    if (response.status === 502 || response.status === 503) throw new Error(unavailableMessage);
    throw new Error(`Die Route konnte nicht berechnet werden (HTTP ${response.status}). Bitte erneut versuchen.`);
  }
  return response.json();
}

// The planner's leg through the points, as the routing service's /leg reads it from its route.
function request(points: Coord[], signal: AbortSignal, background = false): Promise<LegGeometry> {
  const params = new URLSearchParams({ profile: routingProfile, lonlats: points.map(point => point.join(',')).join('|'), format: 'geojson', alternativeidx: '0' });
  // Guide the initial search and its refinement; road costs stay in the profile.
  for (const [name, value] of Object.entries(routingParameters)) params.set(`profile:${name}`, String(value));
  return withSlot(signal, async () => {
    const leg = await answer(() => fetch('/routing/leg?' + params, { signal: AbortSignal.any([signal, AbortSignal.timeout(70_000)]) }), signal);
    // an engine from before /leg answers it as /brouter
    if (!Array.isArray((leg as Partial<LegGeometry>).coordinates)) throw new Error('Der Routing-Dienst ist veraltet. Bitte die lokalen Dienste neu starten.');
    return leg as LegGeometry;
  }, background);
}

export function traceGpxPortion(points: Coord[], signal: AbortSignal) {
  return request(points, signal, true);
}

// A loop suggested by the routing service, with the points whose towns name it (`along`).
// `sections`: the leg cut into about 5 km between shaping points, as a chosen loop opens.
export interface LoopFound { leg: LegGeometry; sections: LegGeometry[]; heading: string; cells: string[]; back: boolean; along: Coord[] }

// A whole loop search on the engine's twelve threads: three rounds of twelve round trips and up to 24 rides out and
// back, five turns of searches of at most a minute each.
const loopsTimeout = 5 * 60_000 + 10_000;

// The routing service's loop suggestions (its /loops): the dice turn and shape its round trips, `earlier` are the
// squares of loops suggested before from there with their weights. Its round trips take turns with other requests
// within the service, so this takes no routing slot.
export async function traceLoops(start: Coord, target: LoopTarget, dice: number[], earlier: { cells: string[]; weight: number }[],
  signal: AbortSignal): Promise<LoopFound[]> {
  const parameters = Object.fromEntries(Object.entries(routingParameters).map(([name, value]) => [name, String(value)]));
  const body = JSON.stringify({ profile: routingProfile, parameters, start, target, random: dice, earlier });
  return await answer(() => fetch('/routing/loops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(loopsTimeout)]) }), signal) as LoopFound[];
}

// The route as FIT courses for Garmin bike computers, which the routing service writes (its /fit): the track as
// `routeTrack` gives it, in as many parts as the service makes of it (one up to 400 km), all in one answer.
export async function courseFit(name: string, track: { coordinates: number[][]; stops: number[] }): Promise<Blob[]> {
  const response = await reach(() => fetch('/routing/fit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...track }), signal: AbortSignal.timeout(60_000) }))
    // a timeout here is no section's fault
    .catch((error: unknown) => {
      throw error instanceof SectionError ? new Error('Die FIT-Datei konnte nicht rechtzeitig erstellt werden.', { cause: error }) : error;
    });
  if (response.status === 502 || response.status === 503) throw new Error(unavailableMessage);
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(`Die FIT-Datei konnte nicht erstellt werden (HTTP ${response.status}${detail ? `: ${detail}` : ''}).`);
  }
  const { parts } = await response.json() as { parts: { name: string; fit: string }[] };
  return parts.map(part => new Blob([Uint8Array.from(atob(part.fit), c => c.charCodeAt(0))], { type: 'application/vnd.ant.fit' }));
}

function checkSnap(requested: Coord, snapped: Coord): void {
  if (distanceMeters(requested, snapped) > maxSnapDistance) {
    throw new PlacementError('Kein geeigneter Radweg innerhalb von 250\u00a0m. Bitte den Punkt näher an eine Straße setzen.');
  }
}

export const routingEngine: RoutingEngine = {
  async snap(coord, signal) {
    const { coordinates } = await request([coord, coord], signal);
    const snapped = coordinates[0];
    checkSnap(coord, snapped);
    return snapped;
  },
  async routeLeg(from, to, signal) {
    const leg = await request([from, to], signal);
    checkSnap(from, leg.coordinates[0]);
    checkSnap(to, leg.coordinates.at(-1)!);
    return { ...leg, routingPolicy: routingPolicyVersion };
  },
};

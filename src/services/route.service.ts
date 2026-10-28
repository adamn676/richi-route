import { distanceMeters, PlacementError, routingConcurrency, SectionError, type Coord, type RoutingEngine } from '../domain/route-model.ts';
import { parseBRouterLeg, parseBRouterLine } from '../domain/route-response.ts';
import { routingProfile, routingParameters, routingPolicyVersion } from '../config/routing-policy.ts';

const maxSnapDistance = 250;
const unavailableMessage = 'Der lokale Routing-Dienst ist nicht erreichbar. Bitte den Routing-Dienst starten und erneut versuchen.';
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

async function request(points: Coord[], signal: AbortSignal, background = false, extra: Record<string, string> = {}): Promise<unknown> {
  const params = new URLSearchParams({ profile: routingProfile, lonlats: points.map(point => point.join(',')).join('|'), format: 'geojson', alternativeidx: '0', ...extra });
  // Guide the initial search and its refinement; road costs stay in the profile.
  for (const [name, value] of Object.entries(routingParameters)) params.set(`profile:${name}`, String(value));
  return withSlot(signal, async () => {
    let response: Response;
    try {
      response = await fetch('/routing/brouter?' + params, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(70_000)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof Error && error.name === 'TimeoutError') throw new SectionError(timeoutMessage, { cause: error });
      throw new Error(unavailableMessage, { cause: error });
    }
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
  }, background);
}

export async function traceGpxPortion(points: Coord[], signal: AbortSignal) {
  return parseBRouterLeg(await request(points, signal, true));
}

// BRouter's round trip: a loop from the start through five points on a circle of this radius, centred in this direction.
export async function traceRoundTrip(start: Coord, radiusMeters: number, direction: number, signal: AbortSignal) {
  return parseBRouterLeg(await request([start], signal, false,
    { engineMode: '4', roundTripDistance: String(Math.round(radiusMeters)), direction: String(direction), roundTripPoints: '5' }));
}

function checkSnap(requested: Coord, snapped: Coord): void {
  if (distanceMeters(requested, snapped) > maxSnapDistance) {
    throw new PlacementError('Kein geeigneter Radweg innerhalb von 250\u00a0m. Bitte den Punkt näher an eine Straße setzen.');
  }
}

export const routingEngine: RoutingEngine = {
  async snap(coord, signal) {
    const { coordinates } = parseBRouterLine(await request([coord, coord], signal));
    const snapped = coordinates[0];
    checkSnap(coord, snapped);
    return snapped;
  },
  async routeLeg(from, to, signal) {
    const leg = parseBRouterLeg(await request([from, to], signal));
    checkSnap(from, leg.coordinates[0]);
    checkSnap(to, leg.coordinates.at(-1)!);
    return { ...leg, routingPolicy: routingPolicyVersion };
  },
};

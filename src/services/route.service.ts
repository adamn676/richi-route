import { distanceMeters, type Coord, type RoutingEngine } from '../domain/route-model.ts';
import { parseBRouterLeg, parseBRouterLine } from '../domain/route-response.ts';
import thalPreference from '../config/thal-preference.json' with { type: 'json' };

const maxSnapDistance = 250;
const profile = 'richi-surface-v4';
const waiting: (() => void)[] = [];
let active = 0;

function pump(): void {
  while (active < 2 && waiting.length) waiting.shift()!();
}

function withSlot<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
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
    waiting.push(start);
    signal.addEventListener('abort', cancel, { once: true });
    pump();
  });
}

async function request(from: Coord, to: Coord, signal: AbortSignal): Promise<unknown> {
  const params = new URLSearchParams({ profile, nogos: thalPreference.nogos, lonlats: [from.join(','), to.join(',')].join('|'), format: 'geojson', alternativeidx: '0' });
  return withSlot(signal, async () => {
    const response = await fetch('/routing/brouter?' + params, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(70_000)]),
    });
    if (!response.ok) throw new Error('Lokales Routing nicht erreichbar oder kein Radweg gefunden. Bitte die Routing-Dienste starten.');
    return response.json();
  });
}

function checkSnap(requested: Coord, snapped: Coord): void {
  if (distanceMeters(requested, snapped) > maxSnapDistance) {
    throw new Error('Kein geeigneter Radweg innerhalb von 250 m. Bitte den Punkt näher an eine Straße setzen.');
  }
}

export const routingEngine: RoutingEngine = {
  async snap(coord, signal) {
    const { coordinates } = parseBRouterLine(await request(coord, coord, signal));
    const snapped = coordinates[0];
    checkSnap(coord, snapped);
    return snapped;
  },
  async routeLeg(from, to, signal) {
    const leg = parseBRouterLeg(await request(from, to, signal));
    checkSnap(from, leg.coordinates[0]);
    checkSnap(to, leg.coordinates.at(-1)!);
    return leg;
  },
};

import { parseDraft, type RouteDraft } from './route-draft.ts';
import { isPlaced, type Waypoint } from './route-model.ts';

export interface SavedRouteSummary {
  id: string;
  revision: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  distanceMeters: number;
  pointCount: number;
}

export function routeName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) {
    throw new Error('Bitte einen Routennamen mit 1 bis 120 Zeichen eingeben.');
  }
  return value.trim();
}

// A route by its placed stops' streets, "Hahnhofweg 26 → Roseggerweg", or a loop by its start; empty without two.
export function routeTitle(waypoints: Waypoint[]): string {
  const stops = waypoints.filter(isPlaced);
  if (stops.length < 2) return '';
  const name = (stop: typeof stops[number]) => (stop.address ?? stop.userInput).split(',')[0] || 'Punkt auf der Karte';
  const [from, to] = [name(stops[0]), name(stops[stops.length - 1])];
  return from === to ? `Runde ab ${from}` : `${from} → ${to}`;
}

export function routeSummary(name: string, draft: RouteDraft): SavedRouteSummary {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), revision: crypto.randomUUID(), name: routeName(name),
    createdAt: now, updatedAt: now,
    distanceMeters: Object.values(draft.legs).reduce((sum, leg) => sum + leg.distanceMeters, 0),
    pointCount: draft.points.length,
  };
}

export function exportRouteBackup(name: string, payload: string): string {
  const draft = parseDraft(payload);
  return JSON.stringify({ format: 'richiroute', version: 1, name: routeName(name), draft });
}

export function importRouteBackup(raw: string): { name: string; payload: string } {
  const data = JSON.parse(raw);
  if (!data || data.format !== 'richiroute' || data.version !== 1) {
    throw new Error('Keine unterstützte RichiRoute-Sicherung. Bitte eine .richiroute.json-Datei wählen.');
  }
  const name = routeName(data.name);
  const draft = parseDraft(JSON.stringify(data.draft));
  return { name, payload: JSON.stringify(draft) };
}

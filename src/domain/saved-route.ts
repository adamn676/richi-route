import { parseDraft, type RouteDraft } from './route-draft.ts';

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

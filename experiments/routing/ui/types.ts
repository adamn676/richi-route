import type { LineString } from 'geojson';

export interface RoutePoint { role: 'stop' | 'shape'; coord: [number, number] }
export interface Scenario {
  id: string;
  split: 'tuning' | 'evaluation';
  title: string;
  revision?: number;
  revisionNote?: string;
  focus: string;
  reviewQuestion: string;
  accessNote?: { text: string; sourceUrl: string; checkedDate: string };
  expectedRoads: string[];
  expectedRoadsSource?: string;
  points: RoutePoint[];
  edit?: { pointIndex: number; coord: [number, number] };
}
export interface Result {
  id: string;
  caseId: string;
  engineId: 'graphhopper' | 'brouter' | 'ors';
  variant: 'automatic' | 'selected' | 'edited';
  repetition: number;
  status: 'ok' | 'error';
  responseMs: number;
  points: RoutePoint[];
  error?: string;
  riderRejection?: { reason: string; recordedDate: string; sourceRunId: string; sourceResultId: string };
  normalized: null | {
    geometry: LineString;
    distanceM: number | null;
    durationS: number | null;
    unknownSurfacePercent: number | null;
    unknownSurfaceM: number;
    attributeNote: string;
  };
}
export interface RunSummary { id: string; createdAt: string; scope: string; status: string; resultCount: number; settings?: string; settingsLabel?: string }
export interface Run extends RunSummary {
  includeOrs?: boolean;
  results: Result[];
  scenarios: Scenario[];
  provenance: { limitations: string[] };
}

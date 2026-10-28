import type { SurfaceReport } from '../domain/surface-corrections.ts';

const failureMessage = 'Die Korrektur konnte nicht gespeichert werden. Bitte den lokalen Planer starten und erneut versuchen.';

// The planner's own server keeps the corrections (see scripts/surface-corrections.ts).
export async function saveSurfaceReport(report: SurfaceReport): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/surface-corrections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
  } catch (error) {
    throw new Error(failureMessage, { cause: error });
  }
  if (!response.ok) throw new Error(failureMessage, { cause: await response.text() });
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function geometryHash(geometry) {
  return createHash('sha256').update(JSON.stringify(geometry.coordinates.map(point => point.slice(0, 2)))).digest('hex');
}

export function applyRiderRejections(run, rejections) {
  return {
    ...run,
    results: run.results.map(result => {
      if (result.status !== 'ok' || !result.normalized) return result;
      const rejection = rejections.find(item => item.caseId === result.caseId && item.engineId === result.engineId
        && item.variant === result.variant && item.geometrySha256 === geometryHash(result.normalized.geometry));
      return rejection ? { ...result, riderRejection: rejection } : result;
    }),
  };
}

export async function withRiderRejections(run) {
  const { rejections } = JSON.parse(await readFile(new URL('./rider-rejections.json', import.meta.url), 'utf8'));
  return applyRiderRejections(run, rejections);
}

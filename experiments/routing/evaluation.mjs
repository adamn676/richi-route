import { createHash } from 'node:crypto';

export function evaluationFingerprint(settings, includeOrs, evidence) {
  const inputs = {
    settings, includeOrs,
    assets: evidence.assets.assets.map(({ file, sha256 }) => [file, sha256]).sort(),
    snapshots: Object.entries(evidence.snapshots).map(([file, value]) => [file, value.sha256]).sort(),
    patchedJar: evidence.brouterPatch.patchedJarSha256,
  };
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

export function validateEvaluation(frozen, settings, includeOrs, evidence) {
  if (frozen.schemaVersion !== 1 || frozen.fingerprint !== evaluationFingerprint(settings, includeOrs, evidence)) {
    throw new Error('Frozen evaluation inputs changed. Restore the recorded settings and data before continuing this round.');
  }
}

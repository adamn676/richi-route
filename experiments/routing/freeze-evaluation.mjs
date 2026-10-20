import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { provenance, root } from './run.mjs';
import { evaluationFingerprint } from './evaluation.mjs';

const settings = 'thal-local-v1';
const includeOrs = true;
const evidence = await provenance(settings, includeOrs);
const id = `evaluation-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
const directory = path.join(root, '.local/evaluations');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, `${id}.json`), JSON.stringify({
  schemaVersion: 1, id, createdAt: new Date().toISOString(),
  settings, includeOrs,
  fingerprint: evaluationFingerprint(settings, includeOrs, evidence),
  provenance: evidence,
  note: 'Settings fixed before rider review of scenarios 07–12. Earlier baseline runs exist; this is not a blind comparison. Record problems without changing settings during the round.',
}, null, 2) + '\n', { flag: 'wx' });
console.log(id);

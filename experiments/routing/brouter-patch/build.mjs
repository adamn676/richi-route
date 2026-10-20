import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.local/brouter');
const staging = path.join(root, '.local/brouter-patch');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const patch = 'ries-bicycle-turn-v1';
const original = await readFile(path.join(output, 'brouter.jar'));
const distributed = await readFile(path.join(root, '.local/extracted/brouter-1.7.10/brouter-1.7.10-all.jar'));
if (sha256(original) !== sha256(distributed)) throw new Error('BRouter input differs from the preserved 1.7.10 release.');
await mkdir(staging, { recursive: true });
await copyFile(path.join(output, 'brouter.jar'), path.join(staging, 'patched.jar'));

// Reuse the installed compiler image; never pull an image or install packages here.
execFileSync('docker', [
  'compose', '-f', path.join(root, 'compose.yml'), 'run', '--rm', '--no-deps', '--pull', 'never',
  '--volume', `${root.replaceAll('\\', '/')}:/patch`, '--entrypoint', 'sh', 'ors', '-c',
  'javac --release 8 -Xlint:-options -encoding UTF-8 -cp /patch/.local/brouter/brouter.jar -d /patch/.local/brouter-patch/classes /patch/brouter-patch/OsmNode.java /patch/brouter-patch/TurnExceptionTest.java && ' +
  'java -cp /patch/.local/brouter-patch/classes:/patch/.local/brouter/brouter.jar TurnExceptionTest && ' +
  'jar uf /patch/.local/brouter-patch/patched.jar -C /patch/.local/brouter-patch/classes btools/mapaccess/OsmNode.class',
], { stdio: 'inherit' });

const source = await readFile(path.join(root, 'brouter-patch/OsmNode.java'));
const jar = await readFile(path.join(staging, 'patched.jar'));
const manifest = {
  patch, engine: 'BRouter 1.7.10', builtAt: new Date().toISOString(),
  originalJarSha256: sha256(original), patchedJarSha256: sha256(jar), sourceSha256: sha256(source),
  relation: 1597055, viaNode: 26017964, fromWay: 114442695, toWay: 24469315,
  evidence: { source: 'Rider report', confirmedAt: '2026-10-19', quote: 'it is allowed to turn left here.' },
  scope: 'Add only the bicycle exception bit to the exact negative restriction at the reported junction. Keep all other restrictions and modes unchanged.',
};
await rename(path.join(staging, 'patched.jar'), path.join(output, 'brouter-ries-bicycle-turn-v1.jar'));
await writeFile(path.join(output, 'patch.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built and tested ${patch}; restart BRouter to activate it.`);

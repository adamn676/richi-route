import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { candidateProfile } from '../profiles.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.local/brouter');
const staging = path.join(root, '.local/brouter-patch');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const patch = 'local-bicycle-v2';
const original = await readFile(path.join(output, 'brouter.jar'));
const distributed = await readFile(path.join(root, '.local/extracted/brouter-1.7.10/brouter-1.7.10-all.jar'));
if (sha256(original) !== sha256(distributed)) throw new Error('BRouter input differs from the preserved 1.7.10 release.');
await mkdir(staging, { recursive: true });
await copyFile(path.join(output, 'brouter.jar'), path.join(staging, 'patched.jar'));

// Reuse the installed compiler image; never pull an image or install packages here.
execFileSync('docker', [
  'compose', '-f', path.join(root, 'compose.yml'), 'run', '--rm', '--no-deps', '--pull', 'never',
  '--volume', `${root.replaceAll('\\', '/')}:/patch`, '--entrypoint', 'sh', 'ors', '-c',
  'javac --release 8 -Xlint:-options -encoding UTF-8 -cp /patch/.local/brouter/brouter.jar -d /patch/.local/brouter-patch/classes /patch/brouter-patch/OsmNode.java /patch/brouter-patch/TurnExceptionTest.java /patch/brouter-patch/OsmPath.java /patch/brouter-patch/StdPath.java /patch/brouter-patch/BExpressionContextWay.java /patch/brouter-patch/WeidwegPassage.java /patch/brouter-patch/WeidwegPassageTest.java && ' +
  'java -cp /patch/.local/brouter-patch/classes:/patch/.local/brouter/brouter.jar TurnExceptionTest && ' +
  'java -cp /patch/.local/brouter-patch/classes:/patch/.local/brouter/brouter.jar btools.router.WeidwegPassageTest && ' +
  'jar uf /patch/.local/brouter-patch/patched.jar -C /patch/.local/brouter-patch/classes btools/mapaccess/OsmNode.class -C /patch/.local/brouter-patch/classes btools/router/OsmPath.class -C /patch/.local/brouter-patch/classes btools/router/StdPath.class -C /patch/.local/brouter-patch/classes btools/router/WeidwegPassage.class -C /patch/.local/brouter-patch/classes btools/expressions/BExpressionContextWay.class',
], { stdio: 'inherit' });

const source = await readFile(path.join(root, 'brouter-patch/OsmNode.java'));
const sources = {};
for (const file of ['OsmPath.java', 'StdPath.java', 'BExpressionContextWay.java', 'WeidwegPassage.java']) sources[file] = sha256(await readFile(path.join(root, 'brouter-patch', file)));
const jar = await readFile(path.join(staging, 'patched.jar'));
const manifest = {
  patch, engine: 'BRouter 1.7.10', builtAt: new Date().toISOString(),
  originalJarSha256: sha256(original), patchedJarSha256: sha256(jar), sourceSha256: sha256(source), sources,
  relation: 1597055, viaNode: 26017964, fromWay: 114442695, toWay: 24469315,
  evidence: { source: 'Rider report', confirmedAt: '2026-10-19', quote: 'it is allowed to turn left here.' },
  scope: 'Preserve the Ries bicycle-turn correction. Enable only the two accepted Weidweg ramped stair flights when the profile opts in; retain dismount tags and reject changed endpoints, intermediate geometry, access or surface tags.',
  weidweg: { ways: [28589123, 28589125], acceptedOn: '2026-10-21', profile: 'richi-weidweg-v1' },
};
const profile = candidateProfile(await readFile(path.join(output, 'profiles2/richi-road.brf'), 'utf8'), 'weidweg-local-v1');
const profileFile = path.join(output, 'profiles2/richi-weidweg-v1.brf');
try { await writeFile(profileFile, profile, { flag: 'wx' }); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (await readFile(profileFile, 'utf8') !== profile) throw new Error('Preserve the existing profile and create a new version.');
}
await rename(path.join(staging, 'patched.jar'), path.join(output, 'brouter-local-bicycle-v2.jar'));
await writeFile(path.join(output, 'local-bicycle-v2.patch.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built and tested ${patch}; restart BRouter to activate it.`);

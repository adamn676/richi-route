import { spawn } from 'node:child_process';
import { access, mkdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.cache/maps');
await mkdir(directory, { recursive: true });
try {
  await access(path.join(directory, 'terrain.pmtiles'));
  console.log('European terrain is already installed.');
  process.exit(0);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const disk = await statfs(directory);
if (disk.bavail * disk.bsize < 18 * 1024 ** 3) throw new Error('Terrain setup needs 3 GiB above the 15 GiB reserve.');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const source = 'https://download.mapterhorn.com/planet.pmtiles';
const partial = path.join(directory, 'terrain.pmtiles.part');
const binary = path.join(root, '.cache/tools/pmtiles/pmtiles');
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: 'inherit', signal: controller.signal,
      env: { ...process.env, GODEBUG: 'http2client=0' } });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Terrain setup failed: ${code}`)));
  });
}
const monitor = setInterval(() => {
  void statfs(directory).then(space => {
    if (space.bavail * space.bsize < 15 * 1024 ** 3) controller.abort();
  }).catch(error => controller.abort(error));
}, 1000);
try {
  await run(['extract', source, partial, '--bbox=-25,34,45,72', '--maxzoom=10', '--download-threads=8', '--overfetch=0.01', '--quiet']);
  await run(['verify', partial]);
  await rename(partial, path.join(directory, 'terrain.pmtiles'));
  await writeFile(path.join(directory, 'terrain.json'), JSON.stringify({ source, maxzoom: 10, bounds: [-25, 34, 45, 72], installed: new Date().toISOString() }, null, 2));
  console.log('European terrain is ready. Restart maps:start.');
} finally { clearInterval(monitor); await rm(partial, { force: true }); }

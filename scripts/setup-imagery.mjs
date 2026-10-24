import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rename, statfs, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import config from './imagery.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.cache/imagery');
const pythonPackages = path.join(root, '.cache/imagery-tools');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requirements = await readFile(new URL('./imagery-requirements.txt', import.meta.url));
const revision = hash(JSON.stringify(config) + requirements + await readFile(new URL('./imagery/prepare.py', import.meta.url)));
const marker = path.join(directory, 'ready.json');
await mkdir(directory, { recursive: true });
try {
  if (JSON.parse(await readFile(marker)).revision === revision) {
    await Promise.all(['overview.tif', 'index.json', 'overview/0/0/0.jpg'].map(name => access(path.join(directory, name))));
    await access(path.join(pythonPackages, 'rasterio'));
    await run(['scripts/imagery/render.py', '--prepare-direct']);
    console.log('European imagery overview and tools are ready.'); process.exit(0);
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const space = await statfs(directory);
if (space.bavail * space.bsize < config.reserveBytes + 2 * 1024 ** 3) throw new Error('Imagery setup needs 2 GiB above the 15 GiB disk reserve.');
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', args, { stdio: 'inherit', cwd: root,
      env: { ...process.env, PYTHONPATH: pythonPackages } });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      code === 0 ? resolve() : reject(new Error(`Imagery setup failed: ${code ?? signal}`));
    });
  });
}
await run(['-c', 'import sys; assert sys.version_info >= (3, 12), "Python 3.12 or newer is required"']);
await run(['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '--no-compile',
  '--upgrade', '--target', pythonPackages, '-r', 'scripts/imagery-requirements.txt']);
async function download(url, filename, expected) {
  const destination = path.join(directory, filename);
  try { if (hash(await readFile(destination)) === expected) return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Imagery metadata: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (hash(data) !== expected) throw new Error(`Imagery metadata checksum mismatch: ${filename}`);
  await writeFile(destination + '.part', data);
  await rename(destination + '.part', destination);
}
await download(config.sentinel.manifestUrl, 'manifest.parquet', config.sentinel.manifestSha256);
for (const country of [...config.countries, ...(config.regions ?? [])]) await download(country.boundaryUrl, `${country.id}.geojson`, country.boundarySha256);
await run(['scripts/imagery/prepare.py']);
await run(['scripts/imagery/render.py', '--prepare-direct']);
await writeFile(marker, JSON.stringify({ revision, data: config.revision }, null, 2) + '\n');
console.log('Ready: free European imagery. Restart the local map service.');

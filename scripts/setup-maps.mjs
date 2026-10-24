import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import maps from './maps.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.cache/maps');
const tools = path.join(root, '.cache/tools/pmtiles');
const target = path.join(directory, 'europe.pmtiles');
const partial = target + '.part';
const marker = path.join(directory, 'richiroute-maps.json');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
await mkdir(directory, { recursive: true });
await mkdir(tools, { recursive: true });
async function exists(file) {
  try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function download(url, file, expected) {
  async function digest(candidate) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(candidate)) hash.update(chunk);
    return hash.digest('hex');
  }
  if (await exists(file) && await digest(file) === expected) return;
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(file + '.part'), { signal: controller.signal });
  if (await digest(file + '.part') !== expected) throw new Error(`Checksum mismatch: ${file}`);
  await rename(file + '.part', file);
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    // Large range transfers stalled over HTTP/2 in the native setup.
    const env = { ...process.env, GODEBUG: [process.env.GODEBUG, 'http2client=0'].filter(Boolean).join(',') };
    const child = spawn(command, args, { stdio: 'inherit', signal: controller.signal, env });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Map setup failed: ${code ?? signal}`)));
  });
}
const installed = await exists(marker) ? JSON.parse(await readFile(marker)) : undefined;
const hasArchive = await exists(target);
const ready = hasArchive && installed?.url === maps.url && installed.maxzoom === maps.maxzoom
  && JSON.stringify(installed.bounds) === JSON.stringify(maps.bounds);
if (hasArchive && !ready) throw new Error('Map data already exists. Stop the map service and move the previous archive aside before updating.');
if (!ready) {
  await rm(partial, { force: true });
  const space = await statfs(directory);
  if (space.bavail * space.bsize < 40 * 1024 ** 3) throw new Error('Map setup needs 40 GiB free, including a 15 GiB reserve.');
}
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This native setup supports Linux x64.');
await download(maps.toolUrl, path.join(tools, 'archive.tar.gz'), maps.toolSha256);
if (installed?.toolSha256 !== maps.toolSha256 || !await exists(path.join(tools, 'pmtiles'))) {
  await run('tar', ['-xzf', path.join(tools, 'archive.tar.gz'), '-C', tools, 'pmtiles']);
}
await download(maps.assetsUrl, path.join(directory, 'assets.tar.gz'), maps.assetsSha256);
if (installed?.assetsSha256 !== maps.assetsSha256
  || !await exists(path.join(directory, 'assets/fonts/Noto Sans Regular/0-255.pbf'))
  || !await exists(path.join(directory, 'assets/sprites/v4/light.json'))) {
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  await run('tar', ['-xzf', path.join(directory, 'assets.tar.gz'), '--strip-components=1', '-C', path.join(directory, 'assets')]);
}
if (ready) {
  await writeFile(marker, JSON.stringify(maps, null, 2) + '\n');
  console.log(`European maps from ${maps.dataDate} are ready.`);
  process.exit(0);
}

const report = setInterval(() => {
  void Promise.all([stat(partial), statfs(directory)]).then(([file, disk]) => {
    console.log(`Europe map: ${(file.blocks * 512 / 1024 ** 3).toFixed(2)} GiB written.`);
    if (disk.bavail * disk.bsize < 15 * 1024 ** 3) controller.abort(new Error('Stopping before disk space falls below 15 GiB.'));
  }).catch(error => { if (error.code !== 'ENOENT') controller.abort(error); });
}, 30_000);
try {
  console.log(`Downloading European street maps from ${maps.dataDate}, zoom 0–${maps.maxzoom}.`);
  const binary = path.join(tools, 'pmtiles');
  await run(binary, ['extract', maps.url, partial, `--bbox=${maps.bounds.join(',')}`,
    `--maxzoom=${maps.maxzoom}`, '--download-threads=16', '--overfetch=0.01', '--quiet']);
  await run(binary, ['verify', partial]);
  await rename(partial, target);
  await writeFile(marker, JSON.stringify(maps, null, 2) + '\n');
  console.log('Ready: local European maps. Run npm run maps:start.');
} finally {
  clearInterval(report);
}

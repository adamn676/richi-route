import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import photon from './photon.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.cache/services/photon');
const target = path.join(directory, photon.region);
const jar = path.join(directory, `photon-${photon.version}.jar`);
const gib = 1024 ** 3;
await mkdir(directory, { recursive: true });

async function exists(file) {
  try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function digest(file, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function freeBytes() {
  const stats = await statfs(directory);
  return stats.bavail * stats.bsize;
}
function completed(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Data extraction failed: ${code ?? signal}`)));
  });
}

async function* downloadChunks(url, signal) {
  const head = await fetch(url, { method: 'HEAD', signal });
  const size = Number(head.headers.get('content-length'));
  if (!head.ok || !Number.isSafeInteger(size) || size <= 0) throw new Error('Cannot determine the search download size.');
  const chunkSize = 64 * 1024 * 1024;
  const pending = new Map();
  const start = index => {
    const first = index * chunkSize, last = Math.min(first + chunkSize, size) - 1;
    pending.set(index, (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetch(url, { headers: { Range: `bytes=${first}-${last}` },
            signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
          if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${first}-${last}/${size}`) {
            throw new Error('Search download returned an invalid byte range.');
          }
          const data = Buffer.from(await response.arrayBuffer());
          if (data.length !== last - first + 1) throw new Error('Search download was truncated.');
          return { data };
        } catch (error) {
          signal.throwIfAborted();
          if (attempt === 2) throw error;
          await delay(1000 * (attempt + 1), undefined, { signal });
        }
      }
    })().catch(error => ({ error })));
  };
  const count = Math.ceil(size / chunkSize);
  for (let i = 0; i < Math.min(4, count); i++) start(i);
  for (let i = 0; i < count; i++) {
    const result = await pending.get(i);
    pending.delete(i);
    if (result.error) throw result.error;
    if (i + 4 < count) start(i + 4);
    yield result.data;
  }
}

if (!await exists(jar)) {
  console.log(`Downloading Photon ${photon.version}...`);
  const response = await fetch(photon.url);
  if (!response.ok || !response.body) throw new Error(`Photon download: HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(jar + '.part'));
  if (await digest(jar + '.part', 'sha256') !== photon.sha256) throw new Error('Photon binary checksum mismatch.');
  await rename(jar + '.part', jar);
} else if (await digest(jar, 'sha256') !== photon.sha256) throw new Error('Installed Photon binary checksum mismatch.');

const marker = path.join(target, 'richiroute-search.json');
if (await exists(marker) && JSON.parse(await readFile(marker)).dataMd5 === photon.dataMd5) {
  console.log(`Photon ${photon.version} and ${photon.region} data are ready.`);
  process.exit(0);
}
if (await exists(target)) throw new Error('Search data already exists. Stop Photon and move the previous dataset aside before installing another version.');
if (await freeBytes() < 65 * gib) throw new Error('Europe search installation needs at least 65 GiB free; extraction keeps a 15 GiB reserve.');

const staging = await mkdtemp(path.join(directory, 'europe-staging-'));
const controller = new AbortController();
const abort = () => controller.abort(new Error('Search setup cancelled.'));
process.once('SIGINT', abort);
process.once('SIGTERM', abort);
const parallelDecoder = path.join(root, '.cache/tools/pbzip2/usr/bin/pbzip2');
const parallel = await exists(parallelDecoder);
const decoder = spawn(parallel ? parallelDecoder : 'bzip2', parallel ? ['-dc', '-p6'] : ['-dc'], { stdio: ['pipe', 'pipe', 'inherit'] });
const extractor = spawn('tar', ['-xf', '-', '-C', staging], { stdio: ['pipe', 'ignore', 'inherit'] });
const extraction = [completed(decoder), completed(extractor)];
const hash = createHash('md5');
let received = 0, reportedAt = 0;
const progress = new Transform({ transform(chunk, _encoding, callback) {
  hash.update(chunk); received += chunk.length;
  if (Date.now() - reportedAt > 10_000) {
    console.log(`Europe search: ${(received / gib).toFixed(2)} GiB downloaded and extracting...`);
    reportedAt = Date.now();
  }
  callback(null, chunk);
} });
const spaceCheck = setInterval(() => {
  void freeBytes().then(bytes => {
    if (bytes < 15 * gib) controller.abort(new Error('Stopping before the disk reserve falls below 15 GiB.'));
  }).catch(error => controller.abort(error));
}, 10_000);
try {
  console.log(`Installing ${photon.region} search data from ${photon.dataDate}; streaming extraction avoids retaining the 32 GB archive.`);
  await Promise.all([
    ...extraction,
    pipeline(downloadChunks(photon.dataUrl, controller.signal), progress, decoder.stdin, { signal: controller.signal }),
    pipeline(decoder.stdout, extractor.stdin, { signal: controller.signal }),
  ]);
  if (hash.digest('hex') !== photon.dataMd5) throw new Error('Search data checksum mismatch.');
  if (!await exists(path.join(staging, 'photon_data'))) throw new Error('The downloaded archive has no Photon database.');
  await writeFile(path.join(staging, 'richiroute-search.json'), JSON.stringify(photon, null, 2) + '\n');
  await rename(staging, target);
  console.log(`Ready: local ${photon.region} search. Run npm run search:start.`);
} finally {
  clearInterval(spaceCheck);
  controller.abort(); decoder.kill(); extractor.kill();
  await Promise.allSettled(extraction);
  await rm(staging, { recursive: true, force: true });
}

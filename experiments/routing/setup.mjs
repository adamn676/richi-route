import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const local = path.join(root, '.local');
const sources = [
  { file: 'downloads/graphhopper-web-11.1.jar', url: 'https://github.com/graphhopper/graphhopper/releases/download/11.1/graphhopper-web-11.1.jar', sha256: '8462f758d9ea49edaded557cec5c687a0a24f004ec371cd4daaeb0534824ea33', version: '11.1' },
  { file: 'downloads/brouter-1.7.10.zip', url: 'https://github.com/abrensch/brouter/releases/download/v1.7.10/brouter-1.7.10.zip', sha256: '023fec3ba997758e8cd7ab9e1bae52e962af3f00b57683e3de86b84ffad01532', version: '1.7.10' },
  { file: 'data/steiermark.osm.pbf', url: 'https://download.openstreetmap.fr/extracts/europe/austria/steiermark.osm.pbf', coverage: 'Styria', dataTimestamp: null },
  { file: 'data/E15_N45.rd5', url: 'https://brouter.de/brouter/segments4/E15_N45.rd5', coverage: '15–20 E, 45–50 N', dataTimestamp: null },
];

async function hash(file) {
  const value = createHash('sha256');
  for await (const chunk of createReadStream(file)) value.update(chunk);
  return value.digest('hex');
}

async function exists(file) {
  return stat(file).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

await mkdir(local, { recursive: true });
const manifestPath = path.join(local, 'assets.json');
const manifest = await exists(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : { schemaVersion: 1, assets: [] };
for (const source of sources) {
  const target = path.join(local, source.file);
  await mkdir(path.dirname(target), { recursive: true });
  const previous = manifest.assets.find((asset) => asset.file === source.file);
  if (await exists(target)) {
    const actual = await hash(target);
    if (actual !== (source.sha256 ?? previous?.sha256)) throw new Error(`Cannot verify existing ${source.file}; preserve it and investigate before retrying.`);
    console.log(`Verified ${source.file}`);
    continue;
  }
  console.log(`Downloading ${source.file}`);
  const response = await fetch(source.url, { signal: AbortSignal.timeout(900_000) });
  if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(`${target}.part`));
  const sha256 = await hash(`${target}.part`);
  if (source.sha256 && source.sha256 !== sha256) throw new Error(`Checksum mismatch: ${source.file}`);
  const asset = { ...source, sha256, bytes: (await stat(`${target}.part`)).size, downloadedAt: new Date().toISOString(), lastModified: response.headers.get('last-modified'), etag: response.headers.get('etag') };
  await rename(`${target}.part`, target);
  manifest.assets = [...manifest.assets.filter((entry) => entry.file !== source.file), asset];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

const extracted = path.join(local, 'extracted');
const archive = path.join(local, 'downloads/brouter-1.7.10.zip');
if (!(await exists(extracted))) {
  if (process.platform === 'win32') {
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(extracted)}`]);
  } else {
    await mkdir(extracted, { recursive: true });
    execFileSync('unzip', ['-q', archive, '-d', extracted]);
  }
}
const files = await readdir(extracted, { recursive: true });
const jar = files.find((file) => path.basename(file) === 'brouter-1.7.10-all.jar');
const profile = files.find((file) => path.basename(file) === 'fastbike.brf');
if (!jar || !profile) throw new Error('BRouter archive layout is unexpected.');
const profileDir = path.join(local, 'brouter/profiles2');
await mkdir(profileDir, { recursive: true });
await mkdir(path.join(local, 'customprofiles'), { recursive: true });
await copyFile(path.join(extracted, jar), path.join(local, 'brouter/brouter.jar'));
await copyFile(path.join(extracted, path.dirname(profile), 'lookups.dat'), path.join(profileDir, 'lookups.dat'));
const original = await readFile(path.join(extracted, profile), 'utf8');
const updated = original.replace(/assign allow_steps\s+= true/, 'assign allow_steps           = false');
if (updated === original) throw new Error('Expected fastbike allow_steps setting is missing.');
await writeFile(path.join(profileDir, 'richi-road.brf'), updated);
manifest.profile = { name: 'richi-road', source: 'BRouter 1.7.10 fastbike.brf', modifications: { allow_steps: false }, sha256: await hash(path.join(profileDir, 'richi-road.brf')) };
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Assets ready. Build the local bicycle-turn patch with npm run bench:brouter:patch (requires the installed ORS compiler image), then start local engines with npm run bench:up.');

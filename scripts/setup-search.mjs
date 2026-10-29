// Installs the local address search: downloads the Austrian address register (BEV) and the OpenStreetMap extracts in
// scripts/search-data.json, builds richi-search (search/) and its index of the routing area.
//   node scripts/setup-search.mjs [--update]
// Downloads already there are reused; --update fetches them again. Each extract is checked against Geofabrik's MD5.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import data from './search-data.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.cache/services/search');
const downloads = path.join(directory, 'downloads');
const register = path.join(downloads, 'register');
const index = path.join(directory, 'routing-area.search');
const marker = path.join(directory, 'richiroute-search.json');
const gib = 1024 ** 3;

async function exists(file) {
  try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed: ${code ?? signal}`)));
  });
}
async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file + '.part'));
  await rename(file + '.part', file);
}
async function md5(file) {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

if (process.argv.includes('--update')) await rm(downloads, { recursive: true, force: true });
await mkdir(path.join(downloads, 'osm'), { recursive: true });
const { bavail, bsize } = await statfs(directory);
if (bavail * bsize < 15 * gib) throw new Error('The address search needs about 15 GiB free while it installs.');
// building the index of the routing area holds about 11 GiB in memory
if (totalmem() < 14 * gib) throw new Error('Building the address search needs a computer with at least 16 GB of memory.');

if (!await exists(path.join(register, 'ADRESSE.csv'))) {
  console.log('Downloading the Austrian address register...');
  const zip = path.join(downloads, 'register.zip');
  await download(data.register, zip);
  await rm(register, { recursive: true, force: true });
  await run('unzip', ['-q', '-o', zip, '-d', register]);
  await rm(zip);
}
const extracts = [];
for (const { region, country } of data.extracts) {
  const file = path.join(downloads, 'osm', `${region.replace('/', '-')}.osm.pbf`);
  if (!await exists(file)) {
    const url = `${data.extractsUrl}${region}-latest.osm.pbf`;
    console.log(`Downloading OpenStreetMap ${region}...`);
    await download(url, file);
    const expected = (await (await fetch(`${url}.md5`)).text()).split(/\s/)[0];
    if (await md5(file) !== expected) {
      await rm(file);
      throw new Error(`${region}: the download does not match its checksum; run the setup again.`);
    }
  }
  extracts.push(`${file}=${country}`);
}

const rust = path.join(root, '.cache/runtime/rust/bin');
const cargo = { env: { ...process.env, PATH: `${rust}:${process.env.PATH}`, CARGO_HOME: path.join(root, '.cache/cargo') } };
const manifest = path.join(root, 'search/Cargo.toml');
await run(path.join(rust, 'cargo'), ['build', '--release', '--manifest-path', manifest], cargo);
console.log('Building the search index; this takes a few minutes...');
await run(path.join(root, 'search/target/release/richi-search'), ['build', index + '.part', register, ...extracts]);
await rename(index + '.part', index);
const registerDate = (await readFile(path.join(register, 'Aktualitaetsstand.txt'), 'latin1')).match(/\d{2}\.\d{2}\.\d{4}/)?.[0];
await writeFile(marker, JSON.stringify({ built: new Date().toISOString(), registerDate, extracts: data.extracts }, null, 2) + '\n');
console.log(`Ready: local address search (address register of ${registerDate}). Run npm run search:start.`);

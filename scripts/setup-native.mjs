import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import versions from './native-runtime.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.cache/runtime');
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This native setup is for Linux x64. Use the documented Node and Java versions on other platforms.');
await mkdir(directory, { recursive: true });
async function exists(file) {
  try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
for (const name of ['node', 'java', 'rust']) {
  const release = versions[name];
  const target = path.join(directory, name);
  const marker = path.join(target, 'richiroute-runtime.json');
  if (await exists(marker) && JSON.parse(await readFile(marker)).sha256 === release.sha256) continue;
  const archive = path.join(directory, path.basename(new URL(release.url).pathname));
  if (!await exists(archive)) {
    console.log(`Downloading ${name} ${release.version}...`);
    const response = await fetch(release.url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    await pipeline(response.body, createWriteStream(archive + '.part'));
    await rename(archive + '.part', archive);
  }
  if (await digest(archive) !== release.sha256) throw new Error(`Checksum mismatch: ${archive}`);
  const staging = await mkdtemp(path.join(directory, `${name}-staging-`));
  const installed = `${staging}-installed`;
  const previous = `${target}-previous`;
  try {
    execFileSync('tar', ['-xf', archive, '--strip-components=1', '-C', staging]);
    let tree = staging;
    // Rust ships its components with an installer rather than as one ready tree.
    if (name === 'rust') {
      execFileSync('sh', [path.join(staging, 'install.sh'), `--prefix=${installed}`, '--disable-ldconfig',
        '--components=rustc,cargo,rust-std-x86_64-unknown-linux-gnu,rustfmt-preview,clippy-preview'], { stdio: 'ignore' });
      tree = installed;
    }
    await writeFile(path.join(tree, 'richiroute-runtime.json'), JSON.stringify(release, null, 2) + '\n');
    await rm(previous, { recursive: true, force: true });
    if (await exists(target)) await rename(target, previous);
    try { await rename(tree, target); }
    catch (error) { if (await exists(previous)) await rename(previous, target); throw error; }
    await rm(previous, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(installed, { recursive: true, force: true });
  }
}
const node = path.join(directory, 'node/bin/node');
const npm = path.join(directory, 'node/lib/node_modules/npm/bin/npm-cli.js');
const env = { ...process.env, PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ''}` };
if (execFileSync(node, [npm, '--version'], { encoding: 'utf8', env }).trim() !== versions.npm) {
  execFileSync(node, [npm, 'install', '--global', '--prefix', path.join(directory, 'node'), `npm@${versions.npm}`], { stdio: 'inherit', env });
}
console.log(`Ready: Node ${versions.node.version}, npm ${versions.npm}, GraalVM Community ${versions.java.version}, Rust ${versions.rust.version}.`);

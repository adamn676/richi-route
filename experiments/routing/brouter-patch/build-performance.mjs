import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sources from './performance/sources.json' with { type: 'json' };

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sourceDir = fileURLToPath(new URL('./performance/', import.meta.url));
const output = path.join(root, 'experiments/routing/.local/brouter-performance');
const baseJar = path.resolve(process.env.BROUTER_BASE_JAR ?? path.join(root, '../richiroute-ubuntu-benchmark/brouter.jar'));
const javaHome = process.env.JAVA_HOME ?? path.join(root, '.cache/runtime/java');
const baseSha256 = '2276b8dc7216a8f1a6ad0a3e6349e8e9b07d5917e2da74fb6b9c8a91e3571312';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const jarFile = path.join(output, 'brouter-performance.jar');
const manifestFile = path.join(output, 'performance.patch.json');
const tests = (await readdir(sourceDir)).filter(file => file.endsWith('Parity.java'));
const fingerprintFiles = ['sources.json', ...sources.map(source => source.file + '.patch'), ...tests];
const fingerprints = Object.fromEntries(await Promise.all(fingerprintFiles.map(async file => [file, sha256(await readFile(path.join(sourceDir, file)))])));
fingerprints['../build-performance.mjs'] = sha256(await readFile(fileURLToPath(import.meta.url)));
if (sha256(await readFile(baseJar)) !== baseSha256) throw new Error('The base JAR differs from the verified bicycle-v2 benchmark engine. Review it before building this overlay.');

if (process.argv.includes('--verify')) {
  const manifest = JSON.parse(await readFile(manifestFile));
  if (manifest.baseJarSha256 !== baseSha256 || manifest.jarSha256 !== sha256(await readFile(jarFile))
    || JSON.stringify(manifest.patches) !== JSON.stringify(fingerprints)) throw new Error('The performance overlay is stale or changed. Rebuild it with npm run bench:brouter:performance.');
  console.log('Verified BRouter performance overlay.');
  process.exit(0);
}

const staging = path.join(output, 'staging');
const upstream = path.join(output, 'upstream');
const classes = path.join(staging, 'classes');
const testClasses = path.join(staging, 'test-classes');
await rm(staging, { recursive: true, force: true });
for (const directory of [upstream, classes, testClasses]) await mkdir(directory, { recursive: true });
const originals = new Map();
for (const source of sources) {
  const cached = path.join(upstream, source.file);
  let original;
  if (source.localSource) original = await readFile(path.resolve(sourceDir, source.localSource));
  else {
    try { original = await readFile(cached); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const response = await fetch(source.url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Cannot download ${source.file}: HTTP ${response.status}`);
      original = Buffer.from(await response.arrayBuffer());
    }
  }
  if (sha256(original) !== source.sha256) throw new Error(`Source checksum differs: ${source.file}`);
  await writeFile(cached, original);
  await writeFile(path.join(staging, source.file), original);
  originals.set(source.file, original.toString('utf8'));
  execFileSync('patch', ['--batch', '--forward', '--fuzz=0', '-p1', '-i', path.join(sourceDir, source.file + '.patch')], { cwd: staging, stdio: 'pipe' });
}
const java = path.join(javaHome, 'bin/java');
const javac = path.join(javaHome, 'bin/javac');
const compile = (target, files, classpath) => execFileSync(javac, ['--release', '8', '-Xlint:-options', '-encoding', 'UTF-8', '-cp', classpath, '-d', target, ...files], { stdio: 'inherit' });
compile(classes, sources.map(source => path.join(staging, source.file)), baseJar);

// Build the references from the checksum-verified originals, not a second copy of the optimization.
const references = {
  'ReferenceLruMap.java': originals.get('LruMap.java').replace('LruMap {', 'ReferenceLruMap {').replace('public LruMap(', 'public ReferenceLruMap('),
};
const context = originals.get('RoutingContext.java');
let distance = context.slice(context.indexOf('  public int calcDistance('), context.indexOf('\n  public OsmPathModel'))
  .replace('public int calcDistance(', 'public static int calcDistance(RoutingContext rc, ');
for (const field of ['nogopoints', 'shortestmatch', 'isEndpoint', 'nogoCost', 'ilonshortest', 'ilatshortest', 'wayfraction']) {
  distance = distance.replace(new RegExp(`\\b${field}\\b`, 'g'), `rc.${field}`);
}
references['ReferenceRoutingContext.java'] = `package btools.router;\nimport btools.util.CheapRuler;\npublic class ReferenceRoutingContext {\n${distance}\n}\n`;
for (const [file, source] of Object.entries(references)) await writeFile(path.join(staging, file), source);
const classpath = [classes, baseJar].join(path.delimiter);
compile(testClasses, [...Object.keys(references).map(file => path.join(staging, file)), ...tests.map(file => path.join(sourceDir, file))], classpath);
for (const test of ['btools.util.LruParity', 'btools.router.DistanceParity']) {
  execFileSync(java, ['-cp', [testClasses, classpath].join(path.delimiter), test], { stdio: 'inherit' });
}
const candidateJar = path.join(staging, 'brouter-performance.jar');
execFileSync(path.join(javaHome, 'bin/jar'), ['--create', '--file', candidateJar, '-C', classes, 'btools']);
const manifest = {
  version: 'initial-route-performance-v1', builtAt: new Date().toISOString(),
  baseJarSha256: baseSha256, jarSha256: sha256(await readFile(candidateJar)), patches: fingerprints,
  compiler: execFileSync(javac, ['-version'], { encoding: 'utf8' }).trim(),
  tests, scope: 'Exact expression-cache indexing, cost fast path and conservative avoidance bounding-box rejection. No road-cost or access-rule changes.',
};
await rename(candidateJar, jarFile);
await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built and tested ${jarFile}. The original engine JAR is unchanged.`);

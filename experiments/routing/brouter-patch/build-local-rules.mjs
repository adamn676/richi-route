import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sources from './rules/sources.json' with { type: 'json' };

const root = fileURLToPath(new URL('../../../', import.meta.url));
const routing = path.join(root, 'experiments/routing');
const sourceDir = path.join(routing, 'brouter-patch/rules');
const output = path.join(routing, '.local/brouter-local-rules');
const baseJar = path.resolve(process.env.BROUTER_BASE_JAR ?? path.join(root, '../richiroute-ubuntu-benchmark/brouter.jar'));
const javaHome = path.resolve(process.env.JAVA_HOME ?? path.join(root, '.cache/runtime/java'));
const sha256 = data => createHash('sha256').update(data).digest('hex');
const jar = path.join(output, 'brouter-local-rules.jar');
const manifestFile = path.join(output, 'manifest.json');
execFileSync(process.execPath, [path.join(routing, 'brouter-patch/build-performance.mjs'), '--verify'], { stdio: 'inherit' });
const inputs = {};
for (const file of (await readdir(sourceDir)).sort()) inputs[file] = sha256(await readFile(path.join(sourceDir, file)));
inputs['../build-local-rules.mjs'] = sha256(await readFile(fileURLToPath(import.meta.url)));
inputs['performance.jar'] = sha256(await readFile(path.join(routing, '.local/brouter-performance/brouter-performance.jar')));
inputs['base.jar'] = sha256(await readFile(baseJar));
if (process.argv.includes('--verify')) {
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (JSON.stringify(manifest.inputs) !== JSON.stringify(inputs) || manifest.jarSha256 !== sha256(await readFile(jar))) throw new Error('The local-rules engine is stale. Run npm run routing:build.');
  console.log('Verified configurable local-rules engine.');
  process.exit(0);
}
const staging = path.join(output, 'staging');
const classes = path.join(staging, 'classes');
const tests = path.join(staging, 'test-classes');
const upstream = path.join(output, 'upstream');
await rm(staging, { recursive: true, force: true });
await mkdir(tests, { recursive: true });
await mkdir(classes, { recursive: true });
await mkdir(upstream, { recursive: true });
execFileSync(path.join(javaHome, 'bin/jar'), ['--extract', '--file', path.join(routing, '.local/brouter-performance/brouter-performance.jar')], { cwd: classes });
for (const source of sources) {
  let bytes;
  if (source.source) bytes = await readFile(path.join(routing, source.source));
  else {
    try { bytes = await readFile(path.join(upstream, source.file)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const response = await fetch(source.url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Cannot download ${source.file}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
  }
  if (sha256(bytes) !== source.sha256) throw new Error(`Review changed engine source: ${source.file}`);
  if (source.url) await writeFile(path.join(upstream, source.file), bytes);
  await writeFile(path.join(staging, source.file), bytes);
  execFileSync('patch', ['--batch', '--forward', '--fuzz=0', '-p1', '-i', path.join(sourceDir, source.file + '.patch')], { cwd: staging, stdio: 'pipe' });
}
const java = path.join(javaHome, 'bin/java'), javac = path.join(javaHome, 'bin/javac');
const compile = (destination, files, classpath) => execFileSync(javac, ['--release', '8', '-Xlint:-options', '-encoding', 'UTF-8', '-cp', classpath, '-d', destination, ...files], { stdio: 'inherit' });
compile(classes, [...sources.map(s => path.join(staging, s.file)), path.join(sourceDir, 'LocalRoutingRules.java'), path.join(sourceDir, 'LocalRulesServer.java')], baseJar);
const classpath = [classes, baseJar].join(path.delimiter);
compile(tests, [path.join(sourceDir, 'LocalRoutingRulesTest.java')], classpath);
execFileSync(java, ['-cp', [tests, classpath].join(path.delimiter), 'btools.router.LocalRoutingRulesTest', path.join(sourceDir, 'regression.tsv')], { stdio: 'inherit' });
const candidate = path.join(staging, 'brouter-local-rules.jar');
const jarManifest = path.join(staging, 'MANIFEST.MF');
await writeFile(jarManifest, 'Manifest-Version: 1.0\nImplementation-Version: 1.7.10\n\n');
execFileSync(path.join(javaHome, 'bin/jar'), ['--create', '--file', candidate, '--manifest', jarManifest, '-C', classes, 'btools']);
await rename(candidate, jar);
await writeFile(manifestFile, JSON.stringify({ version: 1, builtAt: new Date().toISOString(), inputs,
  jarSha256: sha256(await readFile(jar)), compiler: execFileSync(javac, ['-version'], { encoding: 'utf8' }).trim() }, null, 2) + '\n');
console.log(`Built and tested ${jar}. Rules remain external to the JAR.`);

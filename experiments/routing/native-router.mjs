import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = path.join(root, '../richiroute-ubuntu-benchmark');
export const nativeReportDirectory = path.join(root, 'experiments/routing/.local/local-routing-rules');
export const nativeManifest = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));

export async function startNativeRouter({ name, port, legacy = false, rulesFile, javaArgs = [] }) {
  await mkdir(nativeReportDirectory, { recursive: true });
  const log = await open(path.join(nativeReportDirectory, name + '.log'), 'w');
  const overlay = path.join(root, legacy ? 'experiments/routing/.local/brouter-performance/brouter-performance.jar' : 'experiments/routing/.local/brouter-local-rules/brouter-local-rules.jar');
  const profiles = legacy ? path.join(bundle, 'profiles') : path.join(nativeReportDirectory, 'profiles');
  const child = spawn(path.join(root, '.cache/runtime/java/bin/java'), [
    '-Xmx1g', '-XX:+UseParallelGC', '-DmaxRunningTime=60', ...javaArgs,
    ...(legacy ? [] : ['-Drichiroute.rules=' + (rulesFile ?? path.join(nativeReportDirectory, 'rules.tsv'))]),
    '-cp', [overlay, path.join(bundle, 'brouter.jar')].join(path.delimiter),
    legacy ? 'btools.server.RouteServer' : 'btools.router.LocalRulesServer', path.join(bundle, 'data'), profiles,
    path.join(bundle, 'customprofiles'), String(port), '6', '127.0.0.1',
  ], { stdio: ['ignore', log.fd, log.fd] });
  let failure;
  const stopped = new Promise(resolve => {
    child.once('error', error => { failure = error; resolve(); });
    child.once('exit', resolve);
  });
  async function stop() {
    if (child.exitCode === null && !failure) child.kill('SIGTERM');
    await stopped;
    await log.close();
  }
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (failure || child.exitCode !== null) throw failure ?? new Error(`Router exited. See ${name}.log.`);
      try {
        const query = new URLSearchParams({ profile: legacy ? 'richi-weidweg-v1' : 'richi-local-v1',
          lonlats: '15.4329,47.075887|15.4329,47.075887', format: 'geojson', alternativeidx: '0' });
        const response = await fetch(`http://127.0.0.1:${port}/brouter?${query}`, { signal: AbortSignal.timeout(1000) });
        await response.text();
        if (response.ok) return { port, stop };
      } catch {}
      await delay(250);
    }
    throw new Error(`Router did not become ready. See ${name}.log.`);
  } catch (error) { await stop(); throw error; }
}

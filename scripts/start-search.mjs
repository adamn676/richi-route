import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import photon from './photon.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.cache/services/photon');
try { await access(path.join(directory, photon.region, 'richiroute-search.json')); }
catch { throw new Error('Local search data is missing. Run npm run search:setup first.'); }
const child = spawn(path.join(root, '.cache/runtime/java/bin/java'), [
  '-Xms512m', `-Xmx${photon.heap}`, '-XX:ActiveProcessorCount=4',
  '-jar', path.join(directory, `photon-${photon.version}.jar`), 'serve',
  '-data-dir', path.join(directory, photon.region), '-listen-ip', '127.0.0.1',
  '-listen-port', '2322', '-default-language', 'de', '-max-results', '8',
], { stdio: 'inherit' });
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 0; });

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.cache/services/search');
try { await access(path.join(directory, 'richiroute-search.json')); }
catch { throw new Error('Local search data is missing. Run npm run search:setup first.'); }
const child = spawn(path.join(root, 'search/target/release/richi-search'), [
  'serve', path.join(directory, 'routing-area.search'), process.env.SEARCH_PORT ?? '2322', '127.0.0.1',
], { stdio: 'inherit' });
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 0; });

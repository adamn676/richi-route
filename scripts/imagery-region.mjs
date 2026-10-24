// Builds the regional Sentinel mosaic (scripts/imagery/mosaic.py) with the Python tools installed by imagery:setup.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const { status } = spawnSync('python3', ['scripts/imagery/mosaic.py', ...process.argv.slice(2)], { stdio: 'inherit', cwd: root,
  env: { ...process.env, PYTHONPATH: path.join(root, '.cache/imagery-tools') } });
process.exit(status ?? 1);

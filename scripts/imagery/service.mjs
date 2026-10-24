import { createHash } from 'node:crypto';
import { access, mkdir, readdir, statfs } from 'node:fs/promises';
import { Database } from 'node:sqlite';
import path from 'node:path';
import { ImageryCache } from './cache.mjs';
import { createRenderPool } from './pool.mjs';
import { createDirectPhotos } from './direct.mjs';
import config from '../imagery.json' with { type: 'json' };

export function validTile(z, x, y) {
  return [z, x, y].every(Number.isInteger) && z >= 0 && z <= 20 && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;
}

export async function createImagery(root, { offline = process.env.RICHIROUTE_IMAGERY_OFFLINE === '1' } = {}) {
  const directory = path.join(root, '.cache/imagery');
  await Promise.all(['overview.tif', 'index.json'].map(name => access(path.join(directory, name))));
  const regionsDirectory = path.join(directory, 'regions');
  await mkdir(regionsDirectory, { recursive: true });
  const revision = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const cache = new ImageryCache(process.env.RICHIROUTE_IMAGERY_CACHE ?? path.join(directory, 'cache.sqlite'), config.cacheBytes, revision);
  const regions = [];
  for (const file of (await readdir(regionsDirectory)).filter(name => name.endsWith('.mbtiles')).sort().reverse()) {
    const db = new Database(path.join(regionsDirectory, file), { readOnly: true });
    const created = db.prepare("SELECT value FROM metadata WHERE name = 'created'").get()?.value ?? '';
    regions.push({ db, created, query: db.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?') });
  }
  regions.sort((a, b) => b.created.localeCompare(a.created));
  let closed = false;
  const pending = new Map();
  const direct = offline ? undefined : await createDirectPhotos(directory, config.countries);
  const pool = createRenderPool('python3', [path.join(root, 'scripts/imagery/render.py')], {
    env: { ...process.env, PYTHONPATH: path.join(root, '.cache/imagery-tools') }, stdio: ['pipe', 'pipe', 'inherit'],
  }, 8);
  const fallbackPool = createRenderPool('python3', [path.join(root, 'scripts/imagery/render.py')], {
    env: { ...process.env, PYTHONPATH: path.join(root, '.cache/imagery-tools') }, stdio: ['pipe', 'pipe', 'inherit'],
  }, 1);
  async function refreshSwiss() {
    if (offline || closed) return;
    try {
      const response = await fetch('https://api3.geo.admin.ch/rest/services/ech/MapServer/ch.swisstopo.swissimage-product/cacheUpdate',
        { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const data = await response.json();
        if (!closed && typeof data.cache_update === 'string') cache.invalidateSwiss(data.cache_update);
      }
    } catch { /* Existing cached imagery remains usable without a connection. */ }
  }
  void refreshSwiss();
  const refresh = setInterval(() => { void refreshSwiss(); }, 86400000); refresh.unref();
  async function getTile(z, x, y, signal, { regional = true } = {}) {
    if (!validTile(z, x, y)) throw new RangeError('Invalid imagery tile.');
    if (closed) throw new Error('Imagery service is closed.');
    const key = `${regional ? '' : 'national/'}${z}/${x}/${y}`;
    for (const region of regions) {
      const tile = region.query.get(z, x, 2 ** z - 1 - y);
      if (tile) return { data: Buffer.from(tile.tile_data), sources: ['saved-region'], cached: true };
    }
    const cached = cache.get(key);
    if (cached && (!cached.stale || offline)) return { ...cached, cached: true };
    if (pending.has(key) && !pending.get(key).controller.signal.aborted) {
      const entry = pending.get(key);
      entry.signals.add(signal);
      signal?.addEventListener('abort', entry.cancel, { once: true });
      return entry.operation;
    }
    const signals = new Set([signal]);
    const controller = new AbortController();
    const cancel = () => { if ([...signals].every(item => item?.aborted)) controller.abort(); };
    signal?.addEventListener('abort', cancel, { once: true });
    cancel();
    const operation = (async () => {
      try {
        let result;
        if (!regional && direct) {
          try { result = await direct.get(z, x, y, controller.signal); }
          catch (error) { if (controller.signal.aborted) throw error; }
        }
        result ??= await (offline ? fallbackPool : pool).render({ z, x, y, offline, regional }, () => [...signals].every(item => item?.aborted));
        const data = Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data, 'base64');
        const degraded = result.errors.length > 0 || offline && z >= 9;
        if (degraded && cached) return { ...cached, cached: true, stale: true };
        if (!degraded) {
          const space = await statfs(directory);
          if (!closed && space.bavail * space.bsize > config.reserveBytes + data.length + 1024 ** 2) {
            try { return { ...cache.put(key, data, result.sources), cached: false }; }
            catch (error) {
              if (error.errcode !== 13 && error.errcode !== 10) throw error;
              console.error('Imagery cache write failed:', error.message);
            }
          }
        }
        return { data, sources: result.sources, degraded, cached: false };
      } catch (error) {
        if (cached) return { ...cached, cached: true, stale: true };
        if (closed || error.name === 'AbortError' || offline || [...signals].every(item => item?.aborted)) throw error;
        console.error(`Imagery ${key}: ${error.message}`);
        const fallback = await fallbackPool.render({ z, x, y, offline: true });
        return { data: Buffer.from(fallback.data, 'base64'), sources: fallback.sources, degraded: true, cached: false };
      } finally {
        if (pending.get(key)?.controller === controller) pending.delete(key);
        for (const signal of signals) signal?.removeEventListener('abort', cancel);
      }
    })();
    pending.set(key, { operation, signals, cancel, controller });
    return operation;
  }
  return {
    getTile,
    close() {
      closed = true; clearInterval(refresh);
      pool.close(); fallbackPool.close();
      direct?.close();
      for (const region of regions) region.db.close();
      cache.close();
    },
  };
}

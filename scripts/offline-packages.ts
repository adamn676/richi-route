import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

// The offline areas' packages (scripts/build-offline-packages.mjs) under /offline/, as the file host serves them to the
// app: the catalogue and each file, whole or a range of it (a broken download resumes; a map archive is read in pieces).
export function offlinePackages(directory: string): Plugin {
  return {
    name: 'offline-packages',
    configureServer(server) {
      server.middlewares.use('/offline', async (request, response) => {
        const end = (status: number) => { response.statusCode = status; response.end(); };
        if (request.method !== 'GET' && request.method !== 'HEAD') return end(405);
        const name = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, '');
        const file = path.join(directory, name);
        if (!name || path.relative(directory, file).startsWith('..') || name.endsWith('.part')) return end(404);
        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) return end(404);
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
        const from = Number(range?.[1] ?? 0), to = Math.min(range?.[2] ? Number(range[2]) : Infinity, info.size - 1);
        if (range && (from > to)) return end(416);
        response.statusCode = range ? 206 : 200;
        response.setHeader('Content-Length', to - from + 1);
        response.setHeader('Accept-Ranges', 'bytes');
        if (range) response.setHeader('Content-Range', `bytes ${from}-${to}/${info.size}`);
        response.setHeader('Content-Type', name.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        response.setHeader('Cache-Control', 'no-cache');
        if (request.method === 'HEAD') return response.end();
        createReadStream(file, { start: from, end: to }).pipe(response);
      });
    },
  };
}

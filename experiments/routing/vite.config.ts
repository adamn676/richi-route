import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { listRuns, loadScenarios, readRun, runBenchmark, saveReview } from './run.mjs';
import { withRiderRejections } from './rider-feedback.mjs';

function benchmarkApi(): Plugin {
  let busy = false;
  return {
    name: 'local-routing-experiment',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        const send = (status: number, value: unknown) => { res.statusCode = status; res.end(JSON.stringify(value)); };
        const url = new URL(req.url ?? '/', 'http://127.0.0.1:5174');
        try {
          if (req.method === 'GET' && url.pathname === '/map-status') {
            try {
              const response = await fetch('http://127.0.0.1:8989/info', { signal: AbortSignal.timeout(3000), redirect: 'error' });
              const info = await response.json();
              return send(200, { available: response.ok && Array.isArray(info.profiles) });
            } catch { return send(200, { available: false }); }
          }
          if (req.method === 'GET' && url.pathname === '/scenarios') return send(200, await loadScenarios());
          if (req.method === 'GET' && url.pathname === '/runs') return send(200, await listRuns());
          if (req.method === 'GET' && url.pathname === '/run') return send(200, await withRiderRejections(await readRun(url.searchParams.get('id') ?? '')));
          if (req.method !== 'POST' || !['/run', '/review'].includes(url.pathname)) return send(404, { error: 'Unknown endpoint.' });
          if (req.headers.origin !== `http://${req.headers.host}` || !req.headers['content-type']?.startsWith('application/json')) return send(403, { error: 'Use the local comparison page.' });
          let body = '';
          for await (const chunk of req) {
            body += chunk.toString();
            if (body.length > 16384) return send(413, { error: 'Request too large.' });
          }
          const payload = JSON.parse(body);
          if (url.pathname === '/review') return send(200, await saveReview(payload.runId, payload.resultId, payload.review));
          if (busy) return send(409, { error: 'Another comparison is running. Please wait.' });
          if (typeof payload.caseId !== 'string') return send(400, { error: 'Select a scenario.' });
          busy = true;
          try { return send(200, await withRiderRejections(await runBenchmark({ caseId: payload.caseId, settings: payload.settings ?? 'baseline', includeOrs: payload.includeOrs ?? false }))); }
          finally { busy = false; }
        } catch (error) {
          send(400, { error: error instanceof Error ? error.message : 'Request failed.' });
        }
      });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../../node_modules/.vite-routing', import.meta.url)),
  envDir: false,
  publicDir: false,
  plugins: [vue(), benchmarkApi()],
  server: {
    host: '127.0.0.1', port: 5174, strictPort: true,
    proxy: { '/tiles': { target: 'http://127.0.0.1:8989', rewrite: (url) => url.replace(/^\/tiles/, '/mvt') } },
  },
  build: { outDir: '../dist', emptyOutDir: true },
});

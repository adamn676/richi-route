import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import { compileCorrections, formatCorrections, recordReport, validateCorrections } from '../src/domain/surface-corrections.ts';

// Written beside the file and renamed into place, under a name of its own, so that readers and other writers (the
// routing-rules preparation) never see half a file.
export async function replaceFile(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, text);
  await rename(temporary, file);
}

// Saves what the rider reports in the planner (POST /surface-corrections) to the corrections in git and to the routing
// engine's file, which the engine reads again for its next route.
export function surfaceCorrections(config: string, engineFile: string): Plugin {
  let saving = Promise.resolve();
  return {
    name: 'surface-corrections',
    configureServer(server) {
      server.middlewares.use('/surface-corrections', (request, response) => {
        const end = (status: number, text = '') => { response.statusCode = status; response.end(text); };
        // Other sites can send JSON only after a preflight, which goes unanswered here, and reach this server under
        // its own address only.
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host ?? '')) return end(403);
        if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') return end(405);
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 4 << 20) request.destroy();
        });
        request.on('end', () => {
          saving = saving.then(async () => {
            const corrections = validateCorrections(JSON.parse(await readFile(config, 'utf8')));
            const next = recordReport(corrections, JSON.parse(body), new Date().toLocaleDateString('sv'));
            await replaceFile(config, formatCorrections(next));
            await replaceFile(engineFile, compileCorrections(next));
          }).then(() => end(204), (error: unknown) => end(400, error instanceof Error ? error.message : String(error)));
        });
      });
    },
  };
}

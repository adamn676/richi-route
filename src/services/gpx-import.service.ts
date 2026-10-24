import type { GpxTrack } from '../domain/gpx-track.ts';

// Parses in a worker so large files don't block the page; aborting stops the worker.
export function readGpx(bytes: ArrayBuffer, fileName: string, signal: AbortSignal): Promise<GpxTrack> {
  const worker = new Worker(new URL('./gpx-import.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<GpxTrack>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    worker.onmessage = ({ data }: MessageEvent<{ track: GpxTrack } | { error: string }>) =>
      'track' in data ? resolve(data.track) : reject(new Error(data.error));
    worker.onerror = worker.onmessageerror = (event: Event) => {
      event.preventDefault();
      reject(new Error('Die GPX-Datei konnte nicht gelesen werden.'));
    };
    worker.postMessage({ bytes, fileName }, [bytes]);
  }).finally(() => worker.terminate());
}

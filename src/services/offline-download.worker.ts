// Downloads an offline area's files into the origin's private file system: each piece is checked against the
// catalogue's SHA-256 before it is written in place, so a stopped download goes on after the last good piece.
import type { DownloadFile, DownloadReport } from './offline-storage';
import { fileHandle } from './offline-files';

// In-place writes, which only workers have (the DOM types lack them).
interface SyncAccessHandle { getSize(): number; truncate(size: number): void; write(data: BufferSource, options: { at: number }): number; flush(): void; close(): void }
type WorkerFileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccessHandle> };

let controller: AbortController | undefined;
const report = (message: DownloadReport) => postMessage(message);
const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');

onmessage = async ({ data }: MessageEvent<{ files: DownloadFile[]; pieceBytes: number } | 'cancel'>) => {
  if (data === 'cancel') { controller?.abort(); return; }
  const current = controller = new AbortController();
  try {
    await download(data.files, data.pieceBytes, current.signal);
    report({ finished: true });
  } catch (error) {
    report(current.signal.aborted ? { cancelled: true } : { error: error instanceof Error ? error.message : String(error) });
  }
};

async function download(files: DownloadFile[], pieceBytes: number, signal: AbortSignal) {
  let done = 0;
  for (const file of files) {
    const access = await (await fileHandle(file.path, true) as WorkerFileHandle).createSyncAccessHandle();
    try {
      // Only checked pieces are written, so what is there, cut to whole pieces, is good.
      let at = access.getSize() === file.bytes ? file.bytes : Math.floor(access.getSize() / pieceBytes) * pieceBytes;
      access.truncate(at);
      done += at;
      report({ done });
      if (at === file.bytes) continue;
      const response = await fetch(file.url, { headers: at ? { Range: `bytes=${at}-` } : {}, signal });
      if (response.status !== (at ? 206 : 200) || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      let piece = new Uint8Array(Math.min(pieceBytes, file.bytes - at)), filled = 0;
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        for (let offset = 0; offset < chunk.value.length;) {
          if (!piece.length) throw new Error('Die Datei ist größer als angegeben.');
          const taken = Math.min(piece.length - filled, chunk.value.length - offset);
          piece.set(chunk.value.subarray(offset, offset + taken), filled);
          filled += taken;
          offset += taken;
          if (filled < piece.length) continue;
          if (hex(await crypto.subtle.digest('SHA-256', piece)) !== file.pieces[at / pieceBytes]) throw new Error('Die geladenen Daten sind beschädigt.');
          access.write(piece, { at });
          at += piece.length;
          done += piece.length;
          report({ done });
          piece = new Uint8Array(Math.min(pieceBytes, file.bytes - at));
          filled = 0;
        }
      }
      if (at !== file.bytes) throw new Error('Die Verbindung brach ab.');
      access.flush();
    } finally {
      access.close();
    }
  }
}

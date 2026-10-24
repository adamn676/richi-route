import { decodeGpx, parseGpx } from '../domain/gpx-import.ts';

onmessage = ({ data }: MessageEvent<{ bytes: ArrayBuffer; fileName: string }>) => {
  try { postMessage({ track: parseGpx(decodeGpx(data.bytes), data.fileName) }); }
  catch (error) { postMessage({ error: (error as Error).message }); }
};

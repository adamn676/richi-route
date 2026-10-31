import { transaction } from './database.service';
import { removeFile } from './offline-files';

// The offline areas' packages (scripts/build-offline-packages.mjs): where they come from, what is on the device, and
// the downloads, which run in a worker.
export interface CatalogueFile { path: string; bytes: number; pieces: string[] }
export type Bounds = [west: number, south: number, east: number, north: number];
export interface CatalogueArea { id: string; bounds: Bounds; bytes: number; files: CatalogueFile[]; squares: string[] }
export interface Catalogue { built: string; pieceBytes: number; routing: { squares: Record<string, CatalogueFile> }; areas: CatalogueArea[] }
// What an area on the device was loaded from: each file's pieces, to tell when the catalogue has newer ones; its bounds
// tell the map which tiles it may have, also offline.
export interface StoredArea { id: string; bounds: Bounds; loadedAt: number; files: Record<string, string> }
export type DownloadFile = CatalogueFile & { url: string };
export type DownloadReport = { done: number } | { finished: true } | { cancelled: true } | { error: string };

// The file host, or in development the packages built here.
const packagesUrl = (import.meta.env?.VITE_OFFLINE_URL?.trim() || '/offline').replace(/\/+$/, '');

export async function loadCatalogue(): Promise<Catalogue> {
  const response = await fetch(`${packagesUrl}/catalogue.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
// An area's own files and its routing squares, which neighbouring areas share.
export const areaFiles = (catalogue: Catalogue, area: CatalogueArea): CatalogueFile[] =>
  [...area.files, ...area.squares.map(square => catalogue.routing.squares[square])];
export const signature = (file: CatalogueFile) => file.pieces.join('');

// Downloads the files one after another; `progress` gets the bytes done of all of them.
export function download(files: CatalogueFile[], pieceBytes: number, progress: (done: number) => void, signal: AbortSignal): Promise<void> {
  const worker = new Worker(new URL('./offline-download.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<void>((resolve, reject) => {
    signal.addEventListener('abort', () => worker.postMessage('cancel'), { once: true });
    worker.onmessage = ({ data }: MessageEvent<DownloadReport>) => {
      if ('done' in data) progress(data.done);
      else if ('finished' in data) resolve();
      else if ('cancelled' in data) reject(signal.reason);
      else reject(new Error(data.error));
    };
    worker.onerror = (event: Event) => { event.preventDefault(); reject(new Error('Laden nicht möglich.')); };
    worker.postMessage({ files: files.map(file => ({ ...file, url: `${packagesUrl}/${file.path}` })), pieceBytes });
  }).finally(() => worker.terminate());
}

export const storedAreas = () => transaction<StoredArea[]>('readonly', ['offlineAreas'], (tx, result, _fail, guard) => {
  const request = tx.objectStore('offlineAreas').getAll();
  request.onsuccess = guard(() => result(request.result));
});
export const keepStored = (area: StoredArea) => transaction<void>('readwrite', ['offlineAreas'], tx => {
  tx.objectStore('offlineAreas').put(area);
});
export const forgetStored = (id: string) => transaction<void>('readwrite', ['offlineAreas'], tx => {
  tx.objectStore('offlineAreas').delete(id);
});
export const removeFiles = (paths: string[]) => Promise.all(paths.map(removeFile));

// The areas on the device, for what reads their files (map tiles, address search); a change lets those open them again.
export type DeviceArea = Pick<StoredArea, 'id' | 'bounds'>;
let device: DeviceArea[] = [];
const changes: (() => void)[] = [];
export const deviceAreas = () => device;
export const onDeviceChange = (reset: () => void) => { changes.push(reset); };
export function setDeviceAreas(areas: DeviceArea[]) {
  device = areas;
  for (const reset of changes) reset();
}
// Whether bounds hold a point, or overlap other bounds.
export const covers = ([west, south, east, north]: Bounds, [lon, lat]: [number, number]) => lon >= west && lon <= east && lat >= south && lat <= north;
export const overlaps = (a: Bounds, b: Bounds) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

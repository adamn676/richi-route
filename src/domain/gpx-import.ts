import type { Coord } from './route-model.ts';
import { buildGpxTrack, type GpxSegment } from './gpx-track.ts';

export const gpxMaxBytes = 32 * 1024 * 1024;
const maxPoints = 250000;

export function decodeGpx(bytes: ArrayBuffer): string {
  const prefix = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 256));
  let encoding: string;
  if ((prefix[0] === 0xff && prefix[1] === 0xfe) || (prefix[0] === 0x3c && prefix[1] === 0)) encoding = 'utf-16le';
  else if ((prefix[0] === 0xfe && prefix[1] === 0xff) || (prefix[0] === 0 && prefix[1] === 0x3c)) encoding = 'utf-16be';
  else encoding = new TextDecoder().decode(prefix).match(/<\?xml\s[^>]*encoding\s*=\s*["']([^"']+)["']/i)?.[1] ?? 'utf-8';
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error('Die Zeichenkodierung der GPX-Datei ist ungültig oder wird nicht unterstützt.'); }
}

function decimal(value: string | null, label: string): number {
  if (value === null || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) {
    throw new Error(`Ungültiger ${label} im GPX-Track.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Ungültiger ${label} im GPX-Track.`);
  return parsed;
}

function children(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter(child => child.localName === name && child.namespaceURI === parent.namespaceURI);
}
function childText(parent: Element, name: string): string {
  return children(parent, name)[0]?.textContent?.trim() ?? '';
}

export async function parseGpx(raw: string, fileName: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (raw.length > gpxMaxBytes) throw new Error('Die GPX-Datei darf höchstens 32 MB groß sein.');
  if (/<!DOCTYPE/i.test(raw)) throw new Error('GPX-Dateien mit Dokumenttyp-Deklarationen werden nicht unterstützt.');
  const document = new DOMParser().parseFromString(raw, 'application/xml');
  const root = document.documentElement;
  if (document.getElementsByTagName('parsererror').length || root.localName !== 'gpx') {
    throw new Error('Die Datei enthält kein gültiges GPX-XML.');
  }
  const namespace = root.namespaceURI;
  if ((namespace && !['http://www.topografix.com/GPX/1/0', 'http://www.topografix.com/GPX/1/1'].includes(namespace)) ||
      !['1.0', '1.1'].includes(root.getAttribute('version') ?? '')) {
    throw new Error('Unterstützt werden GPX-Dateien der Version 1.0 und 1.1.');
  }
  const tracks = children(root, 'trk');
  const segments: GpxSegment[] = [];
  let pointCount = 0;
  for (const track of tracks) {
    const name = childText(track, 'name');
    for (const element of children(track, 'trkseg')) {
      const coordinates: Coord[] = [], elevations: (number | null)[] = [];
      for (let point = element.firstElementChild; point; point = point.nextElementSibling) {
        if (point.localName !== 'trkpt' || point.namespaceURI !== namespace) continue;
        if (++pointCount > maxPoints) throw new Error('Die GPX-Datei enthält mehr als 250.000 Trackpunkte. Bitte die Datei aufteilen.');
        const lon = decimal(point.getAttribute('lon'), 'Längengrad');
        const lat = decimal(point.getAttribute('lat'), 'Breitengrad');
        if (Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new Error('Eine GPX-Koordinate liegt außerhalb des gültigen Bereichs.');
        coordinates.push([lon, lat]);
        const height = children(point, 'ele')[0];
        elevations.push(height ? decimal(height.textContent, 'Höhenwert') : null);
        if (pointCount % 4096 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
          signal?.throwIfAborted();
        }
      }
      if (coordinates.length) segments.push({ name, coordinates, elevations });
    }
  }
  if (!pointCount) throw new Error(children(root, 'rte').length
    ? 'Diese GPX-Datei enthält nur Routenpunkte. Bitte einen GPX-Track mit aufgezeichnetem Streckenverlauf exportieren.'
    : 'Die GPX-Datei enthält keine Trackpunkte.');
  signal?.throwIfAborted();
  const metadata = children(root, 'metadata')[0];
  const name = (metadata ? childText(metadata, 'name') : childText(root, 'name')) ||
    (tracks.length === 1 ? childText(tracks[0], 'name') : '') || fileName.replace(/\.gpx$/i, '');
  return buildGpxTrack(name || 'GPX-Track', fileName, segments);
}

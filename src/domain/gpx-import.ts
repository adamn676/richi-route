import type { Coord } from './route-model.ts';
import { buildGpxTrack, type GpxSegment } from './gpx-track.ts';

export const gpxMaxBytes = 32 * 1024 * 1024;
const maxPoints = 250000;
const gpxNamespaces = ['http://www.topografix.com/GPX/1/0', 'http://www.topografix.com/GPX/1/1'];
// A tag, comment, CDATA section, processing instruction or text, matched only at the current position.
const token = /<(\/?)([^\s<>/=!?"'&]+)((?:\s+[^\s<>/=!?"'&]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|([^<]+)/y;
const attribute = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const reference = /&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([\da-fA-F]+));|&/g;
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// Elements read below each read parent; all others are only checked for well-formedness.
const readChildren: Record<string, Set<string>> = {
  gpx: new Set(['metadata', 'name', 'trk', 'rte']), metadata: new Set(['name']), trk: new Set(['name', 'trkseg']),
  trkseg: new Set(['trkpt']), trkpt: new Set(['ele']),
};
const xmlNamespaces = new Map([['xml', 'http://www.w3.org/XML/1998/namespace']]);
const noAttributes = new Map<string, string>();

interface OpenElement { tag: string; namespaces: Map<string, string>; role?: string }

export function decodeGpx(bytes: ArrayBuffer): string {
  const prefix = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 256));
  let encoding: string;
  if ((prefix[0] === 0xff && prefix[1] === 0xfe) || (prefix[0] === 0x3c && prefix[1] === 0)) encoding = 'utf-16le';
  else if ((prefix[0] === 0xfe && prefix[1] === 0xff) || (prefix[0] === 0 && prefix[1] === 0x3c)) encoding = 'utf-16be';
  else encoding = new TextDecoder().decode(prefix).match(/<\?xml\s[^>]*encoding\s*=\s*["']([^"']+)["']/i)?.[1] ?? 'utf-8';
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error('Die Zeichenkodierung der GPX-Datei ist ungültig oder wird nicht unterstützt.'); }
}

const invalidXml = () => new Error('Die Datei enthält kein gültiges GPX-XML.');

function decimal(value: string | undefined, label: string): number {
  if (value === undefined || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) {
    throw new Error(`Ungültiger ${label} im GPX-Track.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Ungültiger ${label} im GPX-Track.`);
  return parsed;
}

function decode(text: string): string {
  return text.includes('&') ? text.replace(reference, (_, name, digits, hex) => {
    if (name) return entities[name];
    const code = digits ? Number(digits) : hex ? parseInt(hex, 16) : 0;
    if (!code || code > 0x10ffff) throw invalidXml();
    return String.fromCodePoint(code);
  }) : text;
}

function resolve(name: string, namespaces: Map<string, string>): [string | null, string] {
  const colon = name.indexOf(':');
  if (colon < 0) return [namespaces.get('') || null, name];
  const uri = namespaces.get(name.slice(0, colon)), local = name.slice(colon + 1);
  if (!uri || !local || local.includes(':')) throw invalidXml();
  return [uri, local];
}

// Scans the XML without a DOM so that parsing can run in a worker.
export function parseGpx(raw: string, fileName: string) {
  if (raw.length > gpxMaxBytes) throw new Error('Die GPX-Datei darf höchstens 32 MB groß sein.');
  if (/<!DOCTYPE/i.test(raw)) throw new Error('GPX-Dateien mit Dokumenttyp-Deklarationen werden nicht unterstützt.');
  const stack: OpenElement[] = [], segments: GpxSegment[] = [];
  let namespace: string | null | undefined;
  let coordinates: Coord[] = [], elevations: (number | null)[] = [];
  let pointCount = 0, trackCount = 0, trackStart = 0, routes = false, metadata = false;
  let text: string | undefined;
  let documentName: string | undefined, metadataName: string | undefined, trackName: string | undefined;

  function open(tag: string, attributes: string) {
    const parent = stack.at(-1);
    const inherited = parent?.namespaces ?? xmlNamespaces;
    let namespaces = inherited;
    const values = attributes ? new Map<string, string>() : noAttributes;
    let prefixed = false;
    attribute.lastIndex = 0;
    for (let match; attributes && (match = attribute.exec(attributes));) {
      const [, key, double, single] = match;
      if (values.has(key)) throw invalidXml();
      const value = decode(double ?? single);
      values.set(key, value);
      if (key === 'xmlns' || key.startsWith('xmlns:')) {
        if (namespaces === inherited) namespaces = new Map(inherited);
        namespaces.set(key.slice(6), value);
      } else if (key.includes(':')) prefixed = true;
    }
    if (prefixed) for (const key of values.keys()) if (key.includes(':') && !key.startsWith('xmlns:')) resolve(key, namespaces);
    const [uri, local] = resolve(tag, namespaces);
    let role: string | undefined;
    if (!parent) {
      if (namespace !== undefined || local !== 'gpx') throw invalidXml();
      if ((uri && !gpxNamespaces.includes(uri)) || !['1.0', '1.1'].includes(values.get('version') ?? '')) {
        throw new Error('Unterstützt werden GPX-Dateien der Version 1.0 und 1.1.');
      }
      namespace = uri;
      role = 'gpx';
    } else if (parent.role && uri === namespace && readChildren[parent.role]?.has(local)) role = local;
    if (role === 'metadata') { if (metadata) role = undefined; metadata = true; }
    else if (role === 'trk') { trackCount++; trackStart = segments.length; trackName = undefined; }
    else if (role === 'rte') routes = true;
    else if (role === 'trkseg') { coordinates = []; elevations = []; }
    else if (role === 'name' || role === 'ele') text = '';
    else if (role === 'trkpt') {
      if (++pointCount > maxPoints) throw new Error('Die GPX-Datei enthält mehr als 250.000 Trackpunkte. Bitte die Datei aufteilen.');
      const lon = decimal(values.get('lon'), 'Längengrad');
      const lat = decimal(values.get('lat'), 'Breitengrad');
      if (Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new Error('Eine GPX-Koordinate liegt außerhalb des gültigen Bereichs.');
      coordinates.push([lon, lat]);
      elevations.push(null);
    }
    stack.push({ tag, namespaces, role });
  }

  function close(tag: string) {
    const element = stack.pop();
    if (element?.tag !== tag) throw invalidXml();
    const parentRole = stack.at(-1)?.role;
    if (element.role === 'ele') elevations[elevations.length - 1] ??= decimal(text, 'Höhenwert');
    else if (element.role === 'name') {
      const name = text!.replace(/\r\n?/g, '\n').trim();
      if (parentRole === 'gpx') documentName ??= name;
      else if (parentRole === 'metadata') metadataName ??= name;
      else trackName ??= name;
    } else if (element.role === 'trkseg') { if (coordinates.length) segments.push({ name: '', coordinates, elevations }); }
    else if (element.role === 'trk') for (const segment of segments.slice(trackStart)) segment.name = trackName ?? '';
    if (element.role === 'name' || element.role === 'ele') text = undefined;
  }

  token.lastIndex = 0;
  while (token.lastIndex < raw.length) {
    const match = token.exec(raw);
    if (!match) throw invalidXml();
    const [, closing, tag, attributes, empty, cdata, characters] = match;
    if (tag !== undefined) {
      if (!closing) open(tag, attributes);
      else if (attributes || empty) throw invalidXml();
      if (closing || empty) close(tag);
    } else if (cdata !== undefined || characters !== undefined) {
      const value = cdata ?? decode(characters);
      if (!stack.length && (cdata !== undefined || value.trim())) throw invalidXml();
      if (text !== undefined) text += value;
    }
  }
  if (stack.length || namespace === undefined) throw invalidXml();
  if (!pointCount) throw new Error(routes
    ? 'Diese GPX-Datei enthält nur Routenpunkte. Bitte einen GPX-Track mit aufgezeichnetem Streckenverlauf exportieren.'
    : 'Die GPX-Datei enthält keine Trackpunkte.');
  const name = (metadata ? metadataName : documentName) || (trackCount === 1 ? trackName : '') || fileName.replace(/\.gpx$/i, '');
  return buildGpxTrack(name || 'GPX-Track', fileName, segments);
}

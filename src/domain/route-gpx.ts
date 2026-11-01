import { distanceMeters, legId, type RouteLeg, type RoutePoint } from './route-model.ts';

interface ExportRoute {
  points: RoutePoint[];
  legs: Record<string, RouteLeg>;
  pendingLegCount: number;
  pendingSnapCount: number;
}

export function gpxUnavailableReason(route: ExportRoute): string | null {
  if (route.pendingLegCount || route.pendingSnapCount) return 'Die Route wird noch berechnet.';
  if (route.points.length < 2 || route.points.some(p => !p.coord || p.snapError)) return 'Bitte alle Wegpunkte setzen.';
  let length = 0;
  for (let i = 1; i < route.points.length; i++) {
    const from = route.points[i - 1], to = route.points[i];
    const leg = route.legs[legId(from.id, to.id)];
    if (!leg || leg.status !== 'routed' || leg.error || leg.coordinates.length < 2 ||
        distanceMeters(from.coord!, leg.coordinates[0]) > 2 ||
        distanceMeters(to.coord!, leg.coordinates.at(-1)!) > 2) return 'Bitte zuerst alle gestrichelten Abschnitte berechnen.';
    length += leg.distanceMeters;
  }
  return length > 0 ? null : 'Bitte eine Route mit Start und Ziel planen.';
}

function xml(text: string): string {
  return Array.from(text).filter(c => {
    const n = c.codePointAt(0)!;
    return n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xd7ff) ||
      (n >= 0xe000 && n <= 0xfffd) || n >= 0x10000;
  }).join('').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function exportGpx(route: ExportRoute, name = 'RichiRoute'): string {
  const reason = gpxUnavailableReason(route);
  if (reason) throw new Error(reason);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="RichiRoute" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${xml(name)}</name><desc>Geplant mit RichiRoute. Kartendaten © OpenStreetMap-Mitwirkende.</desc></metadata>`,
    `<trk><name>${xml(name)}</name><trkseg>`,
  ];
  trackSegments(route).forEach((segment, index) => {
    if (index) lines.push('</trkseg><trkseg>');
    for (const [lon, lat, elevation] of segment) {
      lines.push(`<trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">${elevation === undefined ? '' : `<ele>${elevation.toFixed(2)}</ele>`}</trkpt>`);
    }
  });
  lines.push('</trkseg></trk></gpx>');
  return lines.join('\n');
}

// The whole track as [longitude, latitude, height where known], as one line (a FIT course has no segments).
export function routeTrack(route: ExportRoute): number[][] {
  return trackSegments(route).flat();
}

// The track in segments: a point two sections share once; a small gap where sections meet starts a new segment
// rather than inventing a connector.
function trackSegments(route: ExportRoute): number[][][] {
  const reason = gpxUnavailableReason(route);
  if (reason) throw new Error(reason);
  const segments: number[][][] = [[]];
  for (let i = 1; i < route.points.length; i++) {
    const leg = route.legs[legId(route.points[i - 1].id, route.points[i].id)];
    leg.coordinates.forEach(([lon, lat], index) => {
      const elevation = leg.elevations?.[index];
      const previous = segments.at(-1)!.at(-1);
      if (index === 0 && previous) {
        const sameCoord = previous[0] === lon && previous[1] === lat;
        if (sameCoord && previous[2] === elevation) return;
        if (!sameCoord) segments.push([]);
      }
      segments.at(-1)!.push(elevation === undefined ? [lon, lat] : [lon, lat, elevation]);
    });
  }
  return segments;
}

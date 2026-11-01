import type { ExpressionSpecification, Map } from 'maplibre-gl';
import type { Feature, Point } from 'geojson';
import { distanceMeters, type Coord } from '../domain/route-model.ts';

// Arrows that show which way a line runs: white navigation arrows with a dark outline and a soft shadow, turned along it.

// A piece of line; `marked` when a marker sits at its end, as at the stops.
export interface ArrowPiece { coordinates: Coord[]; marked?: boolean }

// Every `spacing` metres along each stretch of pieces, counted from its start, a point with the turn of its arrow in
// degrees, leaving out those an eighth of that from the stretch's start or a marked end, where markers
// would cover them. A stretch shorter than that gets one point halfway.
export function arrowPoints(stretches: ArrowPiece[][], spacing: number): Feature<Point>[] {
  return stretches.flatMap(pieces => {
    const points = along(pieces, spacing, spacing / 8);
    return points.length ? points : along(pieces, length(pieces) / 2).slice(0, 1);
  });
}

const pieceLength = ({ coordinates }: ArrowPiece) =>
  coordinates.reduce((meters, coord, i) => i ? meters + distanceMeters(coordinates[i - 1], coord) : 0, 0);
const length = (pieces: ArrowPiece[]) => pieces.reduce((sum, piece) => sum + pieceLength(piece), 0);

function along(pieces: ArrowPiece[], spacing: number, clearance = 0): Feature<Point>[] {
  const points: Feature<Point>[] = [];
  if (!(spacing > 0)) return points;
  const markers = [0];
  pieces.reduce((walked, piece) => {
    const end = walked + pieceLength(piece);
    if (piece.marked) markers.push(end);
    return end;
  }, 0);
  let walked = 0, next = spacing;
  for (const { coordinates } of pieces) {
    for (let i = 1; i < coordinates.length; i++) {
      const [a, b] = [coordinates[i - 1], coordinates[i]], step = distanceMeters(a, b);
      for (; step > 0 && next <= walked + step; next += spacing) {
        if (markers.some(marker => Math.abs(marker - next) < clearance)) continue;
        const share = (next - walked) / step;
        points.push({ type: 'Feature', properties: { turn: turn(a, b) },
          geometry: { type: 'Point', coordinates: [a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share] } });
      }
      walked += step;
    }
  }
  return points;
}

// The arrow points east; turned clockwise by the line's bearing less 90°.
function turn([fromLon, fromLat]: Coord, [toLon, toLat]: Coord): number {
  const east = (toLon - fromLon) * Math.cos(fromLat * Math.PI / 180), north = toLat - fromLat;
  return Math.atan2(east, north) * 180 / Math.PI - 90;
}

// About 110 px apart on screen at the nearest whole zoom step. Halving at each step, each step's points include those of
// the step before, so that zooming only adds or removes points between those that stay.
export function arrowSpacing(zoom: number, latitude: number): number {
  return 110 * 40075016.686 * Math.cos(latitude * Math.PI / 180) / 512 / 2 ** Math.round(zoom);
}

// Calls `update` whenever the zoom reaches another whole step; returns how to stop.
export function onZoomStep(map: Map, update: () => void): () => void {
  let step = Math.round(map.getZoom());
  const zoom = () => {
    const now = Math.round(map.getZoom());
    if (now !== step) { step = now; update(); }
  };
  map.on('zoom', zoom);
  return () => map.off('zoom', zoom);
}

// The arrow image, named `${prefix}`, drawn at twice its size for sharp screens.
export function addArrowImage(map: Map, prefix: string): void {
  if (!map.hasImage(prefix)) map.addImage(prefix, arrow(), { pixelRatio: 2 });
}

// The arrows at the points of `source`, as layer `id`.
export function addArrowLayer(map: Map, id: string, source: string, prefix: string, opacity: ExpressionSpecification | number,
  before: string): void {
  map.addLayer({ id, type: 'symbol', source, paint: { 'icon-opacity': opacity }, layout: { 'icon-image': prefix, 'icon-rotate': ['get', 'turn'],
    'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } }, before);
}

function arrow(): ImageData {
  const size = 18, middle = size / 2, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * 2;
  const c = canvas.getContext('2d')!;
  c.scale(2, 2);
  // Tip ahead, two barbs behind with a notch between them.
  c.beginPath();
  c.moveTo(middle + 6.5, middle);
  c.lineTo(middle - 4.5, middle - 5.5);
  c.lineTo(middle - 1.8, middle);
  c.lineTo(middle - 4.5, middle + 5.5);
  c.closePath();
  c.lineJoin = 'round';
  c.shadowColor = 'rgba(0, 0, 0, .3)';
  c.shadowBlur = 1.8;
  c.shadowOffsetY = .8;
  c.fillStyle = '#ffffff';
  c.fill();
  c.shadowColor = 'transparent';
  c.lineWidth = 1.2;
  c.strokeStyle = '#1c2421';
  c.stroke();
  return c.getImageData(0, 0, canvas.width, canvas.height);
}

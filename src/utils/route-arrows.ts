import type { ExpressionSpecification, Map } from 'maplibre-gl';
import type { Feature, Point } from 'geojson';
import { distanceMeters, type Coord } from '../domain/route-model.ts';

// Glass beads that show which way a line runs: a bead shaded from a light spot to the colour of the line beneath, always
// lit from the top left, with a white rim and a soft shadow, and on it a white chevron turned along the line.

// A stretch of line in one colour, named by `key`; `marked` when a marker sits at its end, as at the stops.
export interface ArrowPiece { coordinates: Coord[]; key: string; marked?: boolean }

// Every `spacing` metres along each stretch of pieces, counted from its start, a point with its piece's key and the turn
// of its chevron in degrees, leaving out those an eighth of that from the stretch's start or a marked end, where markers
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
  for (const { coordinates, key } of pieces) {
    for (let i = 1; i < coordinates.length; i++) {
      const [a, b] = [coordinates[i - 1], coordinates[i]], step = distanceMeters(a, b);
      for (; step > 0 && next <= walked + step; next += spacing) {
        if (markers.some(marker => Math.abs(marker - next) < clearance)) continue;
        const share = (next - walked) / step;
        points.push({ type: 'Feature', properties: { key, turn: turn(a, b) },
          geometry: { type: 'Point', coordinates: [a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share] } });
      }
      walked += step;
    }
  }
  return points;
}

// The chevron points east; turned clockwise by the line's bearing less 90°.
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

// The beads in each colour, named `${prefix}-${key}`, and the chevron, `${prefix}-chevron`; drawn at twice their size for
// sharp screens.
export function addArrowImages(map: Map, prefix: string, colours: Record<string, string>): void {
  const add = (id: string, image: ImageData) => { if (!map.hasImage(id)) map.addImage(id, image, { pixelRatio: 2 }); };
  for (const [key, colour] of Object.entries(colours)) add(`${prefix}-${key}`, draw(c => bead(c, colour)));
  add(`${prefix}-chevron`, draw(chevron));
}

// Beads beneath their chevrons at the points of `source`, named `${id}-beads` and `${id}-chevrons`.
export function addArrowLayers(map: Map, id: string, source: string, prefix: string, opacity: ExpressionSpecification | number,
  before: string): void {
  const layout = { 'icon-allow-overlap': true, 'icon-ignore-placement': true } as const;
  map.addLayer({ id: `${id}-beads`, type: 'symbol', source, paint: { 'icon-opacity': opacity },
    layout: { ...layout, 'icon-image': ['concat', `${prefix}-`, ['get', 'key']], 'icon-rotation-alignment': 'viewport' } }, before);
  map.addLayer({ id: `${id}-chevrons`, type: 'symbol', source, paint: { 'icon-opacity': opacity },
    layout: { ...layout, 'icon-image': `${prefix}-chevron`, 'icon-rotate': ['get', 'turn'], 'icon-rotation-alignment': 'map' } }, before);
}

const size = 18, middle = size / 2;

function draw(paint: (c: CanvasRenderingContext2D) => void): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * 2;
  const c = canvas.getContext('2d')!;
  c.scale(2, 2);
  paint(c);
  return c.getImageData(0, 0, canvas.width, canvas.height);
}

const lighter = (colour: string, share: number) => `rgb(${[1, 3, 5].map(i =>
  Math.round(parseInt(colour.slice(i, i + 2), 16) * (1 - share) + 255 * share)).join(', ')})`;

function bead(c: CanvasRenderingContext2D, colour: string): void {
  const disc = (radius: number, fill: string | CanvasGradient) => {
    c.beginPath();
    c.arc(middle, middle, radius, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
  };
  c.shadowColor = 'rgba(0, 0, 0, .3)';
  c.shadowBlur = 1.8;
  c.shadowOffsetY = .8;
  disc(7.15, '#ffffff');
  c.shadowColor = 'transparent';
  const shine = c.createRadialGradient(middle - 1.9, middle - 2.6, 0, middle - 1.9, middle - 2.6, 9.6);
  shine.addColorStop(0, lighter(colour, .55));
  shine.addColorStop(1, colour);
  disc(5.65, shine);
}

function chevron(c: CanvasRenderingContext2D): void {
  c.beginPath();
  c.moveTo(middle - 1.7, middle - 2.8);
  c.lineTo(middle + 1.7, middle);
  c.lineTo(middle - 1.7, middle + 2.8);
  c.lineWidth = 1.7;
  c.lineCap = c.lineJoin = 'round';
  c.strokeStyle = '#ffffff';
  c.stroke();
}

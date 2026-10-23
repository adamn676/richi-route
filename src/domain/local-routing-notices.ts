import { distanceMeters, type Coord } from './route-model.ts';
import rules from '../config/routing-rules.generated.json' with { type: 'json' };

interface NoticeDefinition {
  id: string;
  text: string;
  direction: string;
  segments: number[][][];
}
interface Segment {
  definition: NoticeDefinition;
  start: Coord;
  end: Coord;
  length: number;
  order: number;
}
interface Bounds { minLon: number; minLat: number; maxLon: number; maxLat: number }
interface Node extends Bounds { segment?: Segment; left?: Node; right?: Node }
export interface RoutingNotice { id: string; text: string }

export function createNoticeIndex(definitions: NoticeDefinition[]) {
  const segments = definitions.flatMap((definition, order) => definition.segments.map(pair => {
    const start: Coord = [pair[0][0], pair[0][1]], end: Coord = [pair[1][0], pair[1][1]];
    return { definition, order, start, end, length: distanceMeters(start, end) };
  }));
  function build(values: Segment[]): Node | undefined {
    if (!values.length) return;
    const node: Node = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
    for (const { start, end } of values) {
      node.minLon = Math.min(node.minLon, start[0], end[0]); node.maxLon = Math.max(node.maxLon, start[0], end[0]);
      node.minLat = Math.min(node.minLat, start[1], end[1]); node.maxLat = Math.max(node.maxLat, start[1], end[1]);
    }
    if (values.length === 1) node.segment = values[0];
    else {
      const axis = node.maxLon - node.minLon > node.maxLat - node.minLat ? 0 : 1;
      values.sort((a, b) => a.start[axis] - b.start[axis]);
      const middle = values.length >>> 1;
      node.left = build(values.slice(0, middle)); node.right = build(values.slice(middle));
    }
    return node;
  }
  const root = build(segments);
  return (legs: readonly { coordinates: Coord[] }[]): RoutingNotice[] => {
    const matches = new Map<string, Segment>();
    function visit(node: Node | undefined, a: Coord, b: Coord): void {
      if (!node || a[0] < node.minLon - 1e-6 && b[0] < node.minLon - 1e-6
        || a[0] > node.maxLon + 1e-6 && b[0] > node.maxLon + 1e-6
        || a[1] < node.minLat - 1e-6 && b[1] < node.minLat - 1e-6
        || a[1] > node.maxLat + 1e-6 && b[1] > node.maxLat + 1e-6) return;
      if (!node.segment) { visit(node.left, a, b); visit(node.right, a, b); return; }
      const segment = node.segment, { start, end, length, definition } = segment;
      if (matches.has(definition.id) || distanceMeters(a, b) < 0.1) return;
      if (definition.direction === 'forward' && (b[0] - a[0]) * (end[0] - start[0]) + (b[1] - a[1]) * (end[1] - start[1]) <= 0) return;
      const onSegment = (point: Coord) => distanceMeters(start, point) + distanceMeters(point, end) < length + 0.02;
      if (onSegment(a) && onSegment(b)) matches.set(definition.id, segment);
    }
    for (const { coordinates } of legs) for (let i = 1; i < coordinates.length; i++) visit(root, coordinates[i - 1], coordinates[i]);
    return [...matches.values()].sort((a, b) => a.order - b.order).map(({ definition }) => ({ id: definition.id, text: definition.text }));
  };
}

export const localRoutingNotices = createNoticeIndex(rules.notices);

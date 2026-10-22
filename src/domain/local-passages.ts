import { distanceMeters, type Coord, type LegGeometry } from './route-model.ts';

const weidwegFlights: [Coord, Coord][] = [
  [[15.397866, 47.10255], [15.397832, 47.102537]],
  [[15.397639, 47.102476], [15.397607, 47.102466]],
];

export function usesWeidwegPassage(legs: LegGeometry[]): boolean {
  return legs.some(({ coordinates }) => coordinates.some((end, i) => {
    // Reject points outside the two flights before doing precise distance checks.
    if (end[0] < 15.39759 || end[0] > 15.39788 || end[1] < 47.10245 || end[1] > 47.10257) return false;
    if (!i || distanceMeters(coordinates[i - 1], end) < 0.1) return false;
    const start = coordinates[i - 1];
    return weidwegFlights.some(([a, b]) => {
      const length = distanceMeters(a, b);
      const onFlight = (p: Coord) => distanceMeters(a, p) + distanceMeters(p, b) < length + 0.02;
      return onFlight(start) && onFlight(end);
    });
  }));
}

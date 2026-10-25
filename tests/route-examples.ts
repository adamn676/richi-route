import type { Coord } from '../src/domain/route-model.ts';

// Routes the browser checks open directly; they were example buttons in the planner.
export const hahnhofweg: Coord[] = [[15.474345, 47.090869], [15.503735, 47.105271]];

// Accepted western composite, indices 0, 45, 119, 146, 175, 245, 385, 644, 874.
// The opening is routed normally; the remaining corridor uses visible shapes.
export const westernLoop: { coords: Coord[]; shapeIndices: number[] } = {
  coords: [
    [15.4329, 47.075887],
    [15.422309, 47.086602],
    [15.410038, 47.098176],
    [15.403888, 47.095942],
    [15.400287, 47.100803],
    [15.391454, 47.099582],
    [15.357768, 47.077057],
    [15.388014, 47.062999],
    [15.4329, 47.075887],
  ],
  shapeIndices: [1, 2, 3, 4, 5, 7],
};

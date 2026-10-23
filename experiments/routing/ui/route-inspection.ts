interface SurfaceSection {
  surface: string;
  fromIndex: number;
  toIndex: number;
  fromM: number;
  toM: number;
}
export interface RouteInspection {
  coordinates: [number, number][];
  distances: number[];
  elevations: (number | null)[];
  sections: SurfaceSection[];
  ascentM: number | null;
  surfaceSource: string;
}
export function surfaceLabel(surface: string): string {
  const labels: Record<string, string> = {
    unknown: 'Unknown', asphalt: 'Asphalt', paved: 'Paved, unspecified',
    concrete: 'Concrete', 'concrete:lanes': 'Concrete lanes', 'concrete:plates': 'Concrete slabs',
    sett: 'Stone setts', cobblestone: 'Cobblestone', paving_stones: 'Paving stones',
    compacted: 'Compacted gravel', fine_gravel: 'Fine gravel', gravel: 'Gravel',
    unpaved: 'Unpaved, unspecified', grass_paver: 'Grass pavers',
  };
  return labels[surface] ?? surface.replace(/_/g, ' ');
}
export function surfaceColor(surface: string): string {
  if (surface === 'asphalt') return '#334155';
  if (['paved', 'concrete', 'concrete:lanes', 'concrete:plates'].includes(surface)) return '#245cdb';
  if (['sett', 'cobblestone', 'paving_stones', 'wood', 'metal', 'grass_paver'].includes(surface)) return '#b46813';
  if (['gravel', 'fine_gravel', 'compacted', 'unpaved', 'ground', 'dirt', 'earth', 'grass', 'sand', 'mud', 'clay', 'rock', 'pebblestone', 'ice', 'woodchips'].includes(surface)) return '#b43b30';
  return '#77818b';
}

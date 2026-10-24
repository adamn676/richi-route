import type { Coord } from '@/domain/route-model';

// Opens Google Street View at the nearest panorama to a point; a plain Maps URL, no API key needed.
export const streetViewUrl = ([lng, lat]: Coord) =>
  `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lng.toFixed(6)}`;

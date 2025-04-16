// For advanced map tile logic (style toggles, offline, theming).
export function getMapTilerStyleUrl(styleType: string): string {
  const API_KEY = import.meta.env.VITE_MAPTILER_KEY;
  switch (styleType) {
    case "outdoor":
      return `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${API_KEY}`;
    case "streets":
    default:
      return `https://api.maptiler.com/maps/streets-v2/style.json?key=${API_KEY}`;
  }
}

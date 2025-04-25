// src/composables/useCustomStyleMap.ts
import maplibregl from "maplibre-gl";
import { useMapStore } from "@/stores/map.store";

export async function createCustomStyleMap(
  containerId: string,
  layersToHide: string[]
) {
  const mapStore = useMapStore();
  const styleUrl = `${mapStore.config.styleUrl}?key=${mapStore.config.apiKey}`;

  // 1) Fetch the style JSON
  const response = await fetch(styleUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch style: ${response.status}`);
  }
  const styleData = await response.json();

  // 2) Filter out any unwanted layers
  styleData.layers = styleData.layers.filter((layer: any) => {
    return !layersToHide.includes(layer.id);
  });

  // 3) Now create the map with the modified style
  const map = new maplibregl.Map({
    container: containerId,
    style: styleData,
    center: mapStore.config.center,
    zoom: mapStore.config.zoom,
  });

  // 4) Save in store if you want to track mapInstance
  mapStore.setMapInstance(map);

  return map;
}

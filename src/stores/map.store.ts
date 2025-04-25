// src/stores/map.store.ts
import { defineStore } from "pinia";
import { reactive, ref } from "vue";
import { type Map as MaplibreMap } from "maplibre-gl";

export type MapConfig = {
  apiKey: string;
  center: [number, number];
  zoom: number;
  styleUrl: string;
};

// Use setup store so TS only has to deal with a few refs/reactives instead of
// inferring a giant object type
export const useMapStore = defineStore("map", () => {
  // Config is a plain reactive object
  const config = reactive<MapConfig>({
    apiKey: import.meta.env.VITE_MAPTILER_API_KEY || "",
    center: [15.439504, 47.070714], // Graz default
    zoom: 13,
    styleUrl: "https://api.maptiler.com/maps/streets-v2/style.json",
  });

  // mapInstance and isMapReady are simple refs
  const mapInstance = ref<MaplibreMap | null>(null);
  const isMapReady = ref(false);

  // Actions:
  function initializeConfig() {
    if (!config.apiKey) {
      console.error(
        "MapTiler API key is not set. Please define VITE_MAPTILER_API_KEY in your .env"
      );
    }
  }

  function setMapInstance(map: MaplibreMap) {
    mapInstance.value = map;
    isMapReady.value = true;
  }

  function updateCenter(center: [number, number]) {
    config.center = center;
    mapInstance.value?.setCenter(center);
  }

  function updateZoom(zoom: number) {
    config.zoom = zoom;
    mapInstance.value?.setZoom(zoom);
  }

  function flyTo(center: [number, number], zoom?: number) {
    if (!mapInstance.value) return;
    mapInstance.value.flyTo({
      center,
      zoom: zoom ?? config.zoom,
      essential: true,
    });
  }

  return {
    config,
    mapInstance,
    isMapReady,
    initializeConfig,
    setMapInstance,
    updateCenter,
    updateZoom,
    flyTo,
  };
});

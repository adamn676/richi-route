import { defineStore } from "pinia";
import maplibregl from "maplibre-gl";

export type MapConfig = {
  apiKey: string;
  center: [number, number];
  zoom: number;
  style: string;
};

export interface MapState {
  config: MapConfig;
  mapInstance: maplibregl.Map | null;
  isMapReady: boolean;
}

export const useMapStore = defineStore("map", {
  state: (): MapState => ({
    config: {
      apiKey: import.meta.env.VITE_MAPTILER_KEY || "",
      center: [15.439504, 47.070714], // Graz, Austria default center
      zoom: 13,
      style: "https://api.maptiler.com/maps/streets/style.json",
    },
    mapInstance: null,
    isMapReady: false,
  }),

  actions: {
    initializeConfig() {
      // Here we could load user preferences or saved map settings
      if (!this.config.apiKey) {
        console.error(
          "MapTiler API key is not set. Please set VITE_MAPTILER_KEY in your .env file."
        );
      }
    },

    setMapInstance(map: maplibregl.Map) {
      this.mapInstance = map;
      this.isMapReady = true;
    },

    updateCenter(center: [number, number]) {
      this.config.center = center;
      this.mapInstance?.setCenter(center);
    },

    updateZoom(zoom: number) {
      this.config.zoom = zoom;
      this.mapInstance?.setZoom(zoom);
    },

    flyTo(center: [number, number], zoom?: number) {
      if (!this.mapInstance) return;

      this.mapInstance.flyTo({
        center,
        zoom: zoom || this.config.zoom,
        essential: true,
      });
    },
  },
});

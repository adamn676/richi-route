// src/composables/useMap.ts
import { ref, onMounted, onBeforeUnmount } from "vue";
import maplibregl, { Map as MaplibreMap } from "maplibre-gl";

// Hold reference to MapLibre map instance
const map = ref<MaplibreMap | null>(null);

/**
 * Initializes a MapLibre map and returns a ref to it
 */
export function useMap(containerId: string) {
  onMounted(() => {
    map.value = new maplibregl.Map({
      container: containerId,
      style: `https://api.maptiler.com/maps/streets/style.json?key=${
        import.meta.env.VITE_MAPTILER_KEY
      }`,
      center: [15.4333, 47.0667],
      zoom: 16,
    });
  });

  onBeforeUnmount(() => {
    map.value?.remove();
  });

  return { map };
}

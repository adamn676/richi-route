// src/composables/useMap.ts
import { ref, onMounted, onBeforeUnmount } from "vue";
import * as maplibregl from "maplibre-gl";
import type { Map as MaplibreMap } from "maplibre-gl";
import { getMapTilerStyleUrl } from "@/services";

export function useMap(containerId: string) {
  const map = ref<MaplibreMap | null>(null);

  onMounted(() => {
    map.value = new maplibregl.Map({
      container: containerId,
      style: getMapTilerStyleUrl("streets-v2"),
      center: [15.4395, 47.0707], // Graz fallback
      zoom: 13,
    });
  });

  onBeforeUnmount(() => {
    map.value?.remove();
  });

  return { map };
}

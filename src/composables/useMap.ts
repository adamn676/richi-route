// src/composables/useMap.ts
import { ref, onMounted, onBeforeUnmount } from "vue";
import * as maplibregl from "maplibre-gl";
import type { Map as MaplibreMap } from "maplibre-gl";
import { getMapTilerStyleUrl } from "@/services";

export function useMap(containerId: string) {
  // Start as a generic ref<any>
  const mapGeneric = ref<any>(null);

  onMounted(() => {
    const realMap = new maplibregl.Map({
      container: containerId,
      style: getMapTilerStyleUrl("streets-v2"),
      center: [15.4395, 47.0707],
      zoom: 13,
    }) as unknown as MaplibreMap;
    mapGeneric.value = realMap;
  });

  onBeforeUnmount(() => {
    mapGeneric.value?.remove?.();
  });

  // Now forcibly cast the entire ref to Ref<MaplibreMap|null>
  const map = mapGeneric as unknown as import("vue").Ref<MaplibreMap | null>;

  return { map };
}

// src/composables/useMapInteractions.ts

import { ref, watch } from "vue";
import type { Ref } from "vue";
import type maplibregl from "maplibre-gl";
import { SEGMENTS_BASE_LAYER } from "@/config/map.config";
import { useNotification } from "@/composables/useNotification";
import type { RouteStore } from "@/stores/route.store";

export function useMapInteractions(
  mapRef: Ref<maplibregl.Map | null>,
  routeStore: RouteStore
) {
  const notify = useNotification();
  const isCalc = ref(false);

  /**
   * Defines how to handle map clicks:
   * - Check if user clicked on the route segment => insert a waypoint
   * - Otherwise => new waypoint
   */
  function setupClickHandler(m: maplibregl.Map) {
    m.on("click", async (e) => {
      // 1) If clicked on an existing segment
      if (routeStore.route && m.getLayer(SEGMENTS_BASE_LAYER)) {
        const feats = m.queryRenderedFeatures(e.point, {
          layers: [SEGMENTS_BASE_LAYER],
        });
        if (feats.length) {
          const idx = (feats[0].properties as any)?.idx as number;
          await routeStore.insertWaypoint(idx + 1, [
            e.lngLat.lng,
            e.lngLat.lat,
          ]);
          return;
        }
      }

      // 2) Fallback: new hard stop
      if (isCalc.value) {
        notify.info("Please wait for calculation...");
        return;
      }
      isCalc.value = true;
      try {
        await routeStore.addWaypoint([e.lngLat.lng, e.lngLat.lat]);
      } finally {
        // re-enable clicks after short delay
        setTimeout(() => (isCalc.value = false), 500);
      }
    });
  }

  /**
   * Whenever mapRef.value becomes a real map, attach the click handler
   */
  watch(
    () => mapRef.value,
    (m) => {
      if (m) setupClickHandler(m);
    },
    { immediate: true }
  );

  return {
    isCalc, // optional: maybe used for debugging or other watchers
  };
}

// src/composables/useRouteCalculation.ts
import { watch } from "vue";
import type { Ref } from "vue";
import { useRouteStore } from "@/stores/route.store";

/**
 * Automatically recalculates the route whenever hard stops or shaping points change.
 *
 * @param options.map  A Ref to your MapLibre‑GL map instance (or any Ref—you just need the same signature).
 */
export function useRouteCalculation(_options: { map: Ref<any> }) {
  const routeStore = useRouteStore();

  // whenever either waypoints or shapingPoints change, recalc
  watch(
    () => [
      // flatten the two arrays into one dependency array
      JSON.stringify(routeStore.waypoints),
      JSON.stringify(routeStore.shapingPoints.map((p) => p.coord)),
    ],
    async () => {
      // runs calculateHardRoute + applyShaping under the hood
      await routeStore.recalc();
    },
    { immediate: true }
  );
}

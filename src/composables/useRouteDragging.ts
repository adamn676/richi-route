import { onMounted, onBeforeUnmount, type Ref } from "vue";
import maplibregl, {
  type MapLayerMouseEvent,
  type MapMouseEvent,
} from "maplibre-gl";
import { useRouteStore } from "@/stores/route.store";

/**
 * Enables "soft‑shaping" drag logic on your route segments.
 *
 * @param options.map  A Ref wrapping your MapLibre‑GL map instance.
 */
export function useRouteDragging(options: { map: Ref<any> }) {
  // Changed to use 'any' instead of strict MaplibreMap type
  const routeStore = useRouteStore();

  let onDown: ((e: MapLayerMouseEvent) => void) | null = null;
  let onMove: ((e: MapMouseEvent) => void) | null = null;
  let onUp: ((e: MapMouseEvent) => void) | null = null;

  onMounted(() => {
    const m = options.map.value;
    if (!m) return;

    onDown = (e: MapLayerMouseEvent) => {
      if (!routeStore.route) return;
      m.dragPan.disable();

      const feat = e.features?.[0];
      const idx = feat?.properties?.idx as number | undefined;
      if (idx == null) {
        m.dragPan.enable();
        return;
      }

      // drop a temporary marker
      const marker = new maplibregl.Marker({ color: "#f59e0b" })
        .setLngLat(e.lngLat)
        .addTo(m as any); // Use 'as any' to bypass type checking

      // follow the cursor
      onMove = (ev) => marker.setLngLat(ev.lngLat);
      m.on("mousemove", onMove);

      // on release, commit the shaping point
      onUp = async (ev) => {
        if (onMove) m.off("mousemove", onMove);
        if (onUp) m.off("mouseup", onUp);
        m.dragPan.enable();

        await routeStore.insertShapingPoint(/* after segment */ idx + 1, [
          ev.lngLat.lng,
          ev.lngLat.lat,
        ]);
        marker.remove();
      };
      m.on("mouseup", onUp);
    };

    m.on("mousedown", "segments-base", onDown);
  });

  onBeforeUnmount(() => {
    const m = options.map.value;
    if (!m) return;
    if (onDown) m.off("mousedown", "segments-base", onDown);
    if (onMove) m.off("mousemove", onMove);
    if (onUp) m.off("mouseup", onUp);
  });
}

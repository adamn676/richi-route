// useRouteDragging.ts
import { onMounted, onBeforeUnmount, type Ref } from "vue";
import maplibregl, {
  type MapLayerMouseEvent,
  type MapMouseEvent,
} from "maplibre-gl";
import { useRouteStore } from "@/stores/route.store";
import { useMapMarkers } from "@/composables/useMapMarkers";
import { SEGMENTS_BASE_LAYER } from "@/config/map.config";

/**
 * Enables "soft‑shaping" drag logic on your route segments.
 *
 * Listens for mousedown on the SEGMENTS_BASE_LAYER, drops a temporary marker,
 * follows the cursor on mousemove, then commits a shaping point on mouseup.
 *
 * @param options.map  A Ref wrapping your MapLibre‑GL map instance.
 */
export function useRouteDragging(options: { map: Ref<any> }) {
  const routeStore = useRouteStore();
  const { createTempMarker } = useMapMarkers(options.map);

  let onDown: ((e: MapLayerMouseEvent) => void) | null = null;
  let onMove: ((e: MapMouseEvent) => void) | null = null;
  let onUp: ((e: MapMouseEvent) => void) | null = null;
  let tempMarker: maplibregl.Marker | null = null;

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

      // Create a temporary marker using our custom marker
      tempMarker = createTempMarker([e.lngLat.lng, e.lngLat.lat], "shaping");

      if (!tempMarker) {
        m.dragPan.enable();
        return;
      }

      // Follow the cursor
      onMove = (ev) => {
        if (tempMarker) tempMarker.setLngLat(ev.lngLat);
      };
      m.on("mousemove", onMove);

      // On release, commit the shaping point
      onUp = async (ev) => {
        if (onMove) m.off("mousemove", onMove);
        if (onUp) m.off("mouseup", onUp);
        m.dragPan.enable();

        await routeStore.insertShapingPoint(/* after segment */ idx + 1, [
          ev.lngLat.lng,
          ev.lngLat.lat,
        ]);

        if (tempMarker) {
          tempMarker.remove();
          tempMarker = null;
        }
      };
      m.on("mouseup", onUp);
    };

    m.on("mousedown", SEGMENTS_BASE_LAYER, onDown);
  });

  onBeforeUnmount(() => {
    const m = options.map.value;
    if (!m) return;
    if (onDown) m.off("mousedown", SEGMENTS_BASE_LAYER, onDown);
    if (onMove) m.off("mousemove", onMove);
    if (onUp) m.off("mouseup", onUp);

    // Clean up any existing temporary marker
    if (tempMarker) {
      tempMarker.remove();
      tempMarker = null;
    }
  });
}

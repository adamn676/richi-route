<template>
  <div id="map" class="h-full w-full">
    <SegmentedRouteLayer :route="routeStore.route" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch, onBeforeUnmount } from "vue";
import maplibregl from "maplibre-gl";
import { useMap } from "@/composables/useMap";
import { useRouteStore } from "@/stores/route.store";
import { useNotification } from "@/composables/useNotification";
import SegmentedRouteLayer from "@/components/map/SegmentedRouteLayer.vue";

const { map } = useMap("map");
const routeStore = useRouteStore();
const notify = useNotification();
const isCalc = ref(false);
const hardMarkers = ref<any[]>([]);
const softMarkers = ref<any[]>([]);

onMounted(() => {
  const m = map.value;
  if (!m) return;

  // click = hard insert (segment or new)
  m.on("click", async (e) => {
    // segment‑based hard insertion
    if (routeStore.route && m.getLayer("segments-base")) {
      const features = m.queryRenderedFeatures(e.point, {
        layers: ["segments-base"],
      });
      if (features.length) {
        const idx = (features[0].properties as any).idx as number;
        await routeStore.insertWaypoint(idx + 1, [e.lngLat.lng, e.lngLat.lat]);
        return;
      }
    }
    // fallback add
    if (isCalc.value) {
      notify.info("Please wait for calculation.");
      return;
    }
    isCalc.value = true;
    try {
      await routeStore.addWaypoint([e.lngLat.lng, e.lngLat.lat]);
    } catch (err: any) {
      notify.error(
        err.response?.status === 429 ? "Rate limit exceeded." : err.message
      );
    } finally {
      setTimeout(() => {
        isCalc.value = false;
      }, 500);
    }
  });

  // drag‑to‑shape = soft insertion
  m.on("mousedown", "segments-base", (e) => {
    if (!routeStore.route) return;
    m.dragPan.disable();

    const feature = e.features?.[0];
    if (!feature) {
      m.dragPan.enable();
      return;
    }
    const idx = (feature.properties as any).idx as number;

    // Create the orange marker
    const marker = new maplibregl.Marker({ color: "#f59e0b" })
      .setLngLat([e.lngLat.lng, e.lngLat.lat])
      //@ts-ignore
      .addTo(m);

    // Handler for moving marker with the map's mousemove
    const onMove = (moveEvent: maplibregl.MapLayerMouseEvent) => {
      marker.setLngLat([moveEvent.lngLat.lng, moveEvent.lngLat.lat]);
    };

    // Handler for ending drag on map's mouseup
    const onUp = async (upEvent: maplibregl.MapLayerMouseEvent) => {
      m.off("mousemove", onMove);
      m.off("mouseup", onUp);
      m.dragPan.enable();

      // Insert as a soft shaping point
      await routeStore.insertShapingPoint(idx, [
        upEvent.lngLat.lng,
        upEvent.lngLat.lat,
      ]);
      marker.remove();
    };

    // Listen on the map, not the window
    m.on("mousemove", onMove);
    m.on("mouseup", onUp);
  });

  // watch hard stops → blue markers
  watch(
    () => routeStore.waypoints.slice(),
    (wps) => {
      const m = map.value;
      if (!m) return;
      hardMarkers.value.forEach((mk: any) => mk.remove());
      hardMarkers.value = [];
      wps.forEach((coord) => {
        const mk = new maplibregl.Marker({ color: "#3b82f6" })
          .setLngLat(coord)
          //@ts-ignore
          .addTo(m);
        hardMarkers.value.push(mk);
      });
    }
  );

  // watch soft stops → orange markers
  watch(
    () => routeStore.shapingPoints.slice(),
    (sps) => {
      const m = map.value;
      if (!m) return;
      softMarkers.value.forEach((mk: any) => mk.remove());
      softMarkers.value = [];
      // sps is an array of { idx, coord }
      sps.forEach(({ coord }) => {
        // coord is [number, number], perfect for setLngLat
        const mk = new maplibregl.Marker({ color: "#f59e0b" })
          .setLngLat(coord as [number, number])
          //@ts-ignore
          .addTo(m);
        softMarkers.value.push(mk);
      });
    }
  );

  onBeforeUnmount(() => {
    hardMarkers.value.forEach((mk: any) => mk.remove());
    softMarkers.value.forEach((mk: any) => mk.remove());
  });
});
</script>

<template>
  <div class="relative w-full">
    <!-- The MapLibre map container -->
    <div ref="mapContainer" class="w-full h-auto"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, onMounted, watch } from "vue";
import maplibregl, { Map, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css"; // **Important** to import default styling
import { useRouteStore } from "@/stores/routeStore";

const mapContainer = ref<HTMLDivElement | null>(null);
const mapInstance = shallowRef<Map | null>(null);

// We’ll store references to any Markers, in case we need to remove them later
const markers = shallowRef<Marker[]>([]);

const routeStore = useRouteStore();
const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;

onMounted(() => {
  if (!mapContainer.value) return;
  console.log(mapContainer.value); // Debug log

  // 1) Init the map with a known center & zoom
  mapInstance.value = new maplibregl.Map({
    container: mapContainer.value,
    style: `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`,
    center: [15.4417, 47.0679], // Graz
    zoom: 16,
  });

  // 2) Add navigation controls
  mapInstance.value.addControl(new maplibregl.NavigationControl(), "top-right");

  // 3) On map click, place a marker + add a waypoint
  mapInstance.value.on("click", (e) => {
    const { lng, lat } = e.lngLat;
    console.log("Map clicked at:", lng, lat); // Debug log

    // a) add waypoint to store
    routeStore.addWaypoint([lng, lat]);

    // b) place a Marker at that location
    const marker = new maplibregl.Marker()
      .setLngLat([lng, lat])
      .addTo(mapInstance.value as Map);
    markers.value.push(marker);
  });
});

// Watch for 2+ waypoints
watch(
  () => routeStore.waypoints,
  (waypoints) => {
    if (waypoints.length > 1) {
      routeStore.calculateRoute();
    }
  },
  { deep: true }
);

// When routeData changes, draw or update the route layer
watch(
  () => routeStore.routeData,
  () => {
    if (!routeStore.routeData) return;
    drawRouteOnMap();
  }
);

// Draw the route using a GeoJSON line
function drawRouteOnMap() {
  if (!mapInstance.value || !routeStore.routeData) return;

  const map = mapInstance.value;
  const sourceId = "routeSource";
  const layerId = "routeLayer";

  // Remove any previous route layer/source
  if (map.getSource(sourceId)) {
    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
    map.removeSource(sourceId);
  }

  map.addSource(sourceId, {
    type: "geojson",
    data: routeStore.routeData,
  });

  map.addLayer({
    id: layerId,
    type: "line",
    source: sourceId,
    paint: {
      "line-color": "#FF5722",
      "line-width": 4,
    },
  });

  // Optionally, auto-fit the map to the route bounding box if provided
  const bbox = routeStore.routeData.bbox;
  if (bbox && bbox.length === 4) {
    // BBox format [minLon, minLat, maxLon, maxLat]
    map.fitBounds(
      [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ],
      { padding: 50 }
    );
  }
}
</script>

<style scoped>
/* Basic style to ensure map container fills the parent area */
</style>

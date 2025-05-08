<!-- src/components/ui/WaypointsPanel.vue -->
<template>
  <div class="bg-white shadow-lg p-4 space-y-4 overflow-y-auto h-full">
    <h2 class="text-xl font-semibold text-gray-700">Route Planner</h2>

    <div
      v-for="(waypoint, index) in routeStore.waypoints"
      :key="waypoint.id"
      class="p-3 border rounded-md shadow-sm bg-gray-50"
    >
      <div class="flex items-center justify-between">
        <span class="font-medium text-indigo-600">{{
          getWaypointLabel(waypoint, index)
        }}</span>
        <Button
          v-if="canRemove(waypoint)"
          icon="pi pi-times"
          class="p-button-text p-button-danger p-button-sm"
          @click="removeWaypoint(waypoint.id)"
          aria-label="Remove waypoint"
        />
      </div>

      <AddressSearchInput
        v-model="waypoint.userInput"
        :waypoint-id="waypoint.id"
        :placeholder="getPlaceholder(waypoint)"
        :disabled="waypoint.isGeocoding"
        :is-geocoding-externally="waypoint.isGeocoding"
        @item-select="onAddressSelect($event, waypoint.id)"
        @text-submit="handleTextSubmit($event, waypoint.id)"
        @geocoding-status="
          (status) => handleGeocodingStatus(waypoint.id, status)
        "
        class="mt-2"
      />

      <div
        v-if="waypoint.isGeocoding && !internalGeocodingStatus[waypoint.id]"
        class="mt-1 text-xs text-gray-500 flex items-center"
      >
        <ProgressSpinner
          style="width: 1rem; height: 1rem; margin-right: 0.5rem"
          strokeWidth="8"
          animationDuration=".5s"
        />
        <span>{{ waypoint.address }}</span>
      </div>
      <div
        v-else-if="
          !waypoint.isGeocoding &&
          waypoint.address &&
          waypoint.userInput !== waypoint.address &&
          waypoint.address !== getPlaceholder(waypoint)
        "
        class="mt-1 text-xs text-gray-500"
      >
        Current: {{ waypoint.address }}
      </div>
    </div>

    <Button
      label="Add Via Point"
      icon="pi pi-plus-circle"
      class="w-full p-button-outlined p-button-sm mt-4"
      @click="addIntermediateStop"
      :disabled="
        routeStore.waypoints.filter(
          (wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0
        ).length < 2
      "
    />

    <Button
      label="Optimize Entire Route"
      icon="pi pi-sparkles"
      class="w-full p-button-sm mt-2"
      @click="optimizeRoute"
      :loading="routeStore.isCalculatingGlobalRoute"
    />
    <Button
      label="Clear Shaping Points"
      icon="pi pi-eraser"
      class="w-full p-button-warning p-button-outlined p-button-sm mt-2"
      @click="clearShapingPoints"
      :disabled="routeStore.shapingPoints.length === 0"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, reactive } from "vue";
import { useRouteStore, type Waypoint } from "@/stores/route.store";
import type { Place } from "@/services/maptiler.service";
import AddressSearchInput from "@/components/common/AddressSearchInput.vue";
import Button from "primevue/button";
import ProgressSpinner from "primevue/progressspinner"; // Keep for other loading states in panel

const routeStore = useRouteStore();
const internalGeocodingStatus = reactive<Record<string, boolean>>({});

const handleGeocodingStatus = (waypointId: string, isLoading: boolean) => {
  internalGeocodingStatus[waypointId] = isLoading;
};

// The onAddressSelect method in WaypointsPanel.vue is already correct:
// it sets waypoint.userInput = selectedPlace.label, making the selection the input's value.
const onAddressSelect = async (selectedPlace: Place, waypointId: string) => {
  const waypoint = routeStore.waypoints.find((wp) => wp.id === waypointId);
  if (waypoint && selectedPlace) {
    waypoint.coords = selectedPlace.coord;
    waypoint.address = selectedPlace.label; // Official address
    waypoint.userInput = selectedPlace.label; // THIS makes it the input value
    waypoint.kind = selectedPlace.kind || waypoint.kind;
    waypoint.isGeocoding = false;
    await routeStore.recalc();
  }
};

// New handler for when user presses Enter on raw text in AddressSearchInput
const handleTextSubmit = async (query: string, waypointId: string) => {
  if (!query.trim()) return;
  const waypoint = routeStore.waypoints.find((wp) => wp.id === waypointId);
  if (waypoint) {
    waypoint.isGeocoding = true; // Show loading in panel
    waypoint.address = `Searching for "${query}"...`;
    // Call the store action that handles forward geocoding a query string
    await routeStore.searchAndSetWaypointAddress(waypointId, query);
    // The store action will set isGeocoding to false and update address/coords
  }
};

const getWaypointLabel = (waypoint: Waypoint, index: number): string => {
  if (waypoint.kind === "start") return "Start";
  if (waypoint.kind === "end") return "End";
  const viaWaypoints = routeStore.waypoints.filter(
    (wp) => wp.kind !== "start" && wp.kind !== "end"
  );
  const viaIndex = viaWaypoints.findIndex((wp) => wp.id === waypoint.id);
  return `Via ${viaIndex >= 0 ? viaIndex + 1 : index}`;
};

const getPlaceholder = (waypoint: Waypoint): string => {
  // Placeholder is shown only when userInput (the value) is empty.
  if (waypoint.isGeocoding) {
    // Show a generic loading/searching message if the store marks it as geocoding
    return waypoint.address?.startsWith("Searching for")
      ? "Searching..."
      : "Loading address...";
  }

  // If not loading and userInput is empty, show the default prompt based on kind
  if (waypoint.kind === "start") return "Search Start or click map";
  if (waypoint.kind === "end") return "Search End or click map";
  if (waypoint.kind === "via") return "Search Via point or click map";

  // Fallback generic placeholder (should rarely be needed if kind is always set)
  return "Search address or click map";
};

const removeWaypoint = async (waypointId: string) => {
  await routeStore.removeWaypoint(waypointId);
};

const addIntermediateStop = async () => {
  await routeStore.addIntermediateStopAndPrepare();
};

const optimizeRoute = async () => {
  await routeStore.optimizeEntireRoute();
};

const clearShapingPoints = async () => {
  await routeStore.clearShaping();
};

const canRemove = (waypoint: Waypoint): boolean => {
  if (waypoint.kind !== "start" && waypoint.kind !== "end") return true;
  return routeStore.waypoints.length > 2;
};

onMounted(() => {
  routeStore.waypoints.forEach((wp) => {
    if (
      !wp.userInput &&
      wp.address &&
      ![
        "Start Point",
        "End Point",
        "Via Point",
        "New Via Point (Search or click map)",
        "Address not found",
        "Address lookup failed",
        "Loading address...",
      ].includes(wp.address) &&
      !wp.address?.startsWith("Searching for") &&
      !wp.address?.startsWith("Locating via")
    ) {
      wp.userInput = wp.address;
    } else if (wp.userInput === undefined) {
      // Check for undefined specifically
      wp.userInput = "";
    }
    internalGeocodingStatus[wp.id] = false;
  });
});

watch(
  () => routeStore.waypoints,
  (newWaypoints) => {
    newWaypoints.forEach((wp) => {
      if (wp.userInput === undefined) {
        wp.userInput = "";
      }
      if (internalGeocodingStatus[wp.id] === undefined) {
        internalGeocodingStatus[wp.id] = false;
      }
    });
  },
  { deep: true }
);
</script>

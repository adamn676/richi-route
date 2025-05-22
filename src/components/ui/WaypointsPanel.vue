<template>
  <div class="bg-white shadow-lg p-4 space-y-4 overflow-y-auto h-full">
    <h2 class="text-xl font-semibold text-gray-700">Route Planner</h2>

    <div v-for="(waypoint, index) in routeStore.waypoints" :key="waypoint.id" class="p-3 border rounded-md shadow-sm bg-gray-50">
      <div class="flex items-center justify-between">
        <span class="font-medium text-indigo-600">{{ getWaypointLabel(waypoint, index) }}</span>
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
        @item-select="(place: Place) => onAddressSelect(place, waypoint.id)"
        @text-submit="(query: string) => handleTextSubmit(query, waypoint.id)"
        @geocoding-status="(status: boolean) => handleChildInputLoading(waypoint.id, status)"
        class="mt-2"
      />

      <div v-if="waypoint.isGeocoding && !childInputLoadingStatus[waypoint.id]" class="mt-1 text-xs text-gray-500 flex items-center">
        <ProgressSpinner style="width: 1rem; height: 1rem; margin-right: 0.5rem" strokeWidth="8" animationDuration=".5s" />
        <span>{{ waypoint.address }}</span>
      </div>

      <div
        v-else-if="
          !waypoint.isGeocoding && waypoint.address && waypoint.userInput !== waypoint.address && isValidAddressForCurrentDisplay(waypoint.address) // Helper to avoid showing default prompts
        "
        class="mt-1 text-xs text-gray-500"
      >
        Current: {{ waypoint.address }}
      </div>
    </div>

    <div class="action-buttons space-y-2 pt-4">
      <Button
        label="Add Via Point"
        icon="pi pi-plus-circle"
        class="w-full p-button-outlined p-button-sm"
        @click="addIntermediateStop"
        :disabled="routeStore.waypoints.filter((wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0).length < 2"
      />
      <Button
        label="Optimize Entire Route"
        icon="pi pi-sparkles"
        class="w-full p-button-sm"
        @click="optimizeRoute"
        :loading="routeStore.isCalculatingGlobalRoute"
      />
      <Button
        label="Clear Shaping Points"
        icon="pi pi-eraser"
        class="w-full p-button-warning p-button-outlined p-button-sm"
        @click="clearShapingPoints"
        :disabled="routeStore.shapingPoints.length === 0"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { watch, onMounted, reactive, nextTick } from 'vue'; // Removed unused imports like computed
import { useRouteStore, type Waypoint } from '@/stores/route.store';
import type { Place } from '@/services/maptiler.service';
import AddressSearchInput from '@/components/common/AddressSearchInput.vue';
import Button from 'primevue/button';
import ProgressSpinner from 'primevue/progressspinner';
// Icon, getIconForPlaceType, useMapStore, turf are NOT needed here anymore,
// as AddressSearchInput handles its own dropdown.

const routeStore = useRouteStore();

// Tracks the internal loading state of each AddressSearchInput child
// Used to coordinate the display of the inline spinner
const childInputLoadingStatus = reactive<Record<string, boolean>>({});

const handleChildInputLoading = (waypointId: string, isLoading: boolean) => {
  childInputLoadingStatus[waypointId] = isLoading;
};

const onAddressSelect = async (selectedPlace: Place, waypointId: string) => {
  const waypoint = routeStore.waypoints.find((wp) => wp.id === waypointId);
  if (waypoint && selectedPlace) {
    console.log(`WaypointsPanel: Address selected for ${waypointId} - ${selectedPlace.label}`);
    // Update the store. This change in waypoint.coords will trigger useMarkerWatches.
    waypoint.coords = selectedPlace.coord;
    waypoint.address = selectedPlace.label;
    waypoint.userInput = selectedPlace.label; // Sync userInput with selected address
    waypoint.kind = selectedPlace.kind || waypoint.kind;
    waypoint.isGeocoding = false; // Selection implies geocoding operation is done
    await routeStore.recalc();
  }
};

const handleTextSubmit = async (query: string, waypointId: string) => {
  if (!query.trim()) return;
  console.log(`WaypointsPanel: Text submitted for ${waypointId} - ${query}`);
  // Let the store handle the full geocoding process and state updates
  await routeStore.searchAndSetWaypointAddress(waypointId, query);
};

const getWaypointLabel = (waypoint: Waypoint, index: number): string => {
  if (waypoint.kind === 'start') return 'Start';
  if (waypoint.kind === 'end') return 'End';
  const viaWaypoints = routeStore.waypoints.filter((wp) => wp.kind !== 'start' && wp.kind !== 'end');
  const viaIndex = viaWaypoints.findIndex((wp) => wp.id === waypoint.id);
  // Adjust index based on whether the first point is a start point that counts
  const baseIndexAdjustment = routeStore.waypoints[0]?.kind === 'start' && index > 0 ? 1 : 0;
  return `Via ${viaIndex >= 0 ? viaIndex + 1 : index - baseIndexAdjustment + 1}`;
};

const defaultPlaceholders = [
  'Start Point',
  'End Point',
  'Via Point',
  'New Via Point (Search or click map)',
  'Loading address...',
  'Searching for...',
  'Address not found',
  'Address lookup failed',
  'Location not found',
];

const isValidAddressForCurrentDisplay = (address: string | null): boolean => {
  if (!address) return false;
  return !defaultPlaceholders.includes(address) && !address.startsWith('Searching for') && !address.startsWith('Loading');
};

const getPlaceholder = (waypoint: Waypoint): string => {
  // This placeholder is shown by the browser if waypoint.userInput is empty.
  // If waypoint.userInput has a value (e.g., from map click geocoding), that value is shown, not the placeholder.
  if (waypoint.isGeocoding && waypoint.address) {
    return waypoint.address; // e.g., "Loading address..." or "Searching for..."
  }

  // For initial state or after a map click (where userInput was set to the address)
  // if userInput is then cleared by the user, show these generic prompts.
  // OR, if userInput is empty and address is a default prompt.
  if (waypoint.kind === 'start') return 'Search Start or click map';
  if (waypoint.kind === 'end') return 'Search End or click map';
  // For a new via point, address might be "New Via Point...", which is fine as placeholder if userInput is empty
  if (waypoint.address === 'New Via Point (Search or click map)') return waypoint.address;

  return 'Search address or click map'; // Generic fallback
};

const removeWaypoint = async (waypointId: string) => {
  await routeStore.removeWaypoint(waypointId);
};

const addIntermediateStop = async () => {
  await routeStore.addIntermediateStopAndPrepare();
  await nextTick();
  const newViaPoint = routeStore.waypoints.find(
    (wp) => wp.address === 'New Via Point (Search or click map)' && wp.coords[0] === 0 && wp.coords[1] === 0 && wp.kind === 'via'
  );
  if (newViaPoint) {
    // Focusing the input inside the child component from here is tricky.
    // It's simpler to let the user click into it.
    // For automatic focus, AddressSearchInput would need to expose its inputElement
    // or have a focus() method, and WaypointsPanel would need to get a ref to AddressSearchInput.
    console.log('New via point added, user can click to edit:', newViaPoint.id);
  }
};
const optimizeRoute = async () => {
  await routeStore.optimizeEntireRoute();
};
const clearShapingPoints = async () => {
  await routeStore.clearShaping();
};
const canRemove = (waypoint: Waypoint): boolean => {
  return (waypoint.kind !== 'start' && waypoint.kind !== 'end') || routeStore.waypoints.length > 2;
};

onMounted(() => {
  routeStore.waypoints.forEach((wp) => {
    // If userInput is undefined, or if it's empty AND address is a specific geocoded one, sync them.
    // This ensures that if a map click populates 'address' and 'userInput', it shows.
    // If 'userInput' was then cleared, placeholder logic takes over.
    if (wp.userInput === undefined) {
      wp.userInput = wp.address && !defaultPlaceholders.includes(wp.address) ? wp.address : '';
    }
    childInputLoadingStatus[wp.id] = false;
  });
});

watch(
  () => routeStore.waypoints,
  (newWaypoints) => {
    newWaypoints.forEach((wp) => {
      if (wp.userInput === undefined) {
        wp.userInput = wp.address && !defaultPlaceholders.includes(wp.address) ? wp.address : '';
      }
      if (childInputLoadingStatus[wp.id] === undefined) {
        childInputLoadingStatus[wp.id] = false;
      }
    });
  },
  { deep: true }
);
</script>

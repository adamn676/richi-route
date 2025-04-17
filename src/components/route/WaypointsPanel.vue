<template>
  <div class="waypoints-panel bg-white h-full p-4 flex flex-col">
    <h2 class="text-lg font-semibold mb-4 flex items-center">
      <Icon name="pi-bicycle" class="text-blue-600 mr-2" />
      Route Planner
    </h2>

    <!-- Tabs for routing method -->
    <div class="routing-tabs mb-4">
      <TabView>
        <TabPanel header="Routing">
          <div class="routing-options p-2">
            <!-- Start and destination inputs -->
            <div class="waypoints-container space-y-3">
              <!-- Start point -->
              <div class="waypoint-input flex items-center">
                <div
                  class="waypoint-icon bg-green-500 rounded-full h-6 w-6 flex items-center justify-center mr-3"
                >
                  <Icon name="pi-map-marker" class="text-white text-sm" />
                </div>
                <InputText
                  v-model="startAddress"
                  placeholder="Start point"
                  class="w-full p-inputtext-sm"
                  @input="handleAddressInput('start')"
                />
                <Button
                  icon="pi pi-times"
                  class="p-button-text p-button-rounded p-button-sm ml-2"
                  @click="clearWaypoint('start')"
                  :disabled="!hasStartWaypoint"
                />
              </div>

              <!-- Destination point -->
              <div class="waypoint-input flex items-center">
                <div
                  class="waypoint-icon bg-red-500 rounded-full h-6 w-6 flex items-center justify-center mr-3"
                >
                  <Icon name="pi-flag" class="text-white text-sm" />
                </div>
                <InputText
                  v-model="endAddress"
                  placeholder="Destination"
                  class="w-full p-inputtext-sm"
                  @input="handleAddressInput('end')"
                />
                <Button
                  icon="pi pi-times"
                  class="p-button-text p-button-rounded p-button-sm ml-2"
                  @click="clearWaypoint('end')"
                  :disabled="!hasEndWaypoint"
                />
              </div>

              <!-- Additional waypoints (will only show hard waypoints, not soft shaping points) -->
              <div
                v-for="(waypoint, index) in intermediateHardWaypoints"
                :key="waypoint.id"
                class="waypoint-input flex items-center"
              >
                <div
                  class="waypoint-icon bg-blue-500 rounded-full h-6 w-6 flex items-center justify-center mr-3"
                >
                  <span class="text-white text-xs font-medium">{{
                    index + 1
                  }}</span>
                </div>
                <InputText
                  v-model="waypoint.address"
                  placeholder="Via point"
                  class="w-full p-inputtext-sm"
                  @input="handleWaypointAddressChange(waypoint.id, $event)"
                />
                <Button
                  icon="pi pi-times"
                  class="p-button-text p-button-rounded p-button-sm ml-2"
                  @click="removeWaypoint(waypoint.id)"
                />
              </div>
            </div>

            <!-- Option to apply route modifications -->
            <div class="route-options mt-6">
              <div class="flex items-center justify-between mb-2">
                <span class="font-medium text-sm">Routing Options</span>
                <Button
                  icon="pi pi-refresh"
                  label="Reset"
                  class="p-button-outlined p-button-sm"
                  :disabled="!hasRoute"
                  @click="resetRoute"
                />
              </div>

              <div class="option-item mb-2">
                <Dropdown
                  v-model="selectedRouteType"
                  :options="routeTypeOptions"
                  optionLabel="label"
                  placeholder="Route Type"
                  class="w-full p-inputtext-sm mb-3"
                />
              </div>

              <div class="option-item">
                <div class="flex items-center justify-between">
                  <span class="text-sm">Apply to entire route</span>
                  <InputSwitch v-model="applyToEntireRoute" />
                </div>
                <small class="text-gray-500 text-xs">
                  Turn off to only recalculate modified or newly added segments.
                </small>
              </div>
            </div>
          </div>
        </TabPanel>
        <TabPanel header="Freehand">
          <div class="freehand-options p-2">
            <p class="text-sm text-gray-700 mb-4">
              Use your mouse to draw a custom route directly on the map. Click
              to place points and double-click to finish.
            </p>

            <Button
              icon="pi pi-pencil"
              label="Start Drawing"
              class="p-button-primary w-full mb-2"
              @click="startFreehandDrawing"
            />

            <Button
              icon="pi pi-times"
              label="Cancel"
              class="p-button-outlined w-full"
              :disabled="!isDrawing"
              @click="cancelFreehandDrawing"
            />
          </div>
        </TabPanel>
      </TabView>
    </div>

    <!-- Route information -->
    <div class="route-info mt-4" v-if="hasRoute">
      <h3 class="text-md font-medium mb-2">Route Information</h3>

      <div class="grid grid-cols-2 gap-4">
        <div class="route-stat bg-gray-50 p-3 rounded">
          <div class="text-xs text-gray-500">Distance</div>
          <div class="text-lg font-semibold">
            {{ routeDistance }}
          </div>
        </div>

        <div class="route-stat bg-gray-50 p-3 rounded">
          <div class="text-xs text-gray-500">Duration</div>
          <div class="text-lg font-semibold">
            {{ routeDuration }}
          </div>
        </div>
      </div>

      <div class="route-surfaces mt-4">
        <h4 class="text-sm font-medium mb-2">Surface Types</h4>

        <div class="surface-types flex flex-wrap gap-2">
          <div
            class="surface-type flex items-center bg-gray-50 px-2 py-1 rounded text-xs"
          >
            <div class="w-3 h-3 rounded-full bg-blue-500 mr-1"></div>
            <span>Paved: 80%</span>
          </div>

          <div
            class="surface-type flex items-center bg-gray-50 px-2 py-1 rounded text-xs"
          >
            <div class="w-3 h-3 rounded-full bg-amber-500 mr-1"></div>
            <span>Unpaved: 20%</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Spacer to push action buttons to bottom -->
    <div class="flex-grow"></div>

    <!-- Action buttons -->
    <div class="action-buttons mt-4 space-y-2">
      <Button
        icon="pi pi-download"
        label="Export GPX"
        class="p-button-outlined w-full"
        :disabled="!hasRoute"
      />

      <Button
        icon="pi pi-share-alt"
        label="Share Route"
        class="p-button-outlined w-full"
        :disabled="!hasRoute"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import TabView from "primevue/tabview";
import TabPanel from "primevue/tabpanel";
import InputText from "primevue/inputtext";
import Dropdown from "primevue/dropdown";
import InputSwitch from "primevue/inputswitch";
import Button from "primevue/button";
import Icon from "../ui/Icon.vue";
import { useRouteStore, WaypointType } from "../../stores/route.store";
import { RouteService } from "../../services/route.service";

// Route store
const routeStore = useRouteStore();

// Local state
const startAddress = ref("");
const endAddress = ref("");
const selectedRouteType = ref({ label: "Recommended", value: "recommended" });
const applyToEntireRoute = ref(true);
const isDrawing = ref(false);

// Route type options
const routeTypeOptions = [
  { label: "Recommended", value: "recommended" },
  { label: "Fastest", value: "fastest" },
  { label: "Shortest", value: "shortest" },
  { label: "Road Bike", value: "cycling-road" },
  { label: "Mountain Bike", value: "cycling-mountain" },
  { label: "Electric Bike", value: "cycling-electric" },
];

// Computed properties
const hasStartWaypoint = computed(() => {
  return routeStore.waypoints.some((wp) => wp.type === WaypointType.START);
});

const hasEndWaypoint = computed(() => {
  return routeStore.waypoints.some((wp) => wp.type === WaypointType.END);
});

const hasRoute = computed(() => {
  return routeStore.route !== null;
});

const intermediateHardWaypoints = computed(() => {
  return routeStore.waypoints.filter((wp) => wp.type === WaypointType.HARD);
});

const routeDistance = computed(() => {
  if (!routeStore.route || !routeStore.route.properties) return "0 km";

  const distance = routeStore.route.properties.summary?.distance || 0;
  return (distance / 1000).toFixed(1) + " km";
});

const routeDuration = computed(() => {
  if (!routeStore.route || !routeStore.route.properties) return "0 min";

  const duration = routeStore.route.properties.summary?.duration || 0;
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);

  if (hours > 0) {
    return `${hours} h ${minutes} min`;
  }

  return `${minutes} min`;
});

// Watch for changes in waypoints
watch(
  () => routeStore.waypoints,
  (waypoints) => {
    // Update start and end addresses
    const start = waypoints.find((wp) => wp.type === WaypointType.START);
    const end = waypoints.find((wp) => wp.type === WaypointType.END);

    startAddress.value = start?.address || "";
    endAddress.value = end?.address || "";
  },
  { deep: true }
);

// Methods
const handleAddressInput = async (type: "start" | "end") => {
  const address = type === "start" ? startAddress.value : endAddress.value;

  if (address.trim().length > 3) {
    // To avoid excessive API calls, we would implement debouncing here
    // For simplicity, we'll just make the call directly

    try {
      const results = await RouteService.geocode(address);

      if (results.length > 0) {
        const firstResult = results[0];

        // Find existing waypoint or create new one
        const existingWaypoint = routeStore.waypoints.find(
          (wp) =>
            wp.type ===
            (type === "start" ? WaypointType.START : WaypointType.END)
        );

        if (existingWaypoint) {
          routeStore.updateWaypoint(existingWaypoint.id, {
            coordinates: firstResult.coordinates,
            address: firstResult.address,
          });
        } else {
          routeStore.addWaypoint({
            type: type === "start" ? WaypointType.START : WaypointType.END,
            name: type === "start" ? "Start" : "End",
            coordinates: firstResult.coordinates,
            address: firstResult.address,
          });
        }
      }
    } catch (error) {
      console.error(`Error geocoding ${type} address:`, error);
    }
  }
};

const handleWaypointAddressChange = async (id: string, event: Event) => {
  const address = (event.target as HTMLInputElement).value;

  if (address.trim().length > 3) {
    try {
      const results = await RouteService.geocode(address);

      if (results.length > 0) {
        const firstResult = results[0];

        routeStore.updateWaypoint(id, {
          coordinates: firstResult.coordinates,
          address: firstResult.address,
        });
      }
    } catch (error) {
      console.error("Error geocoding waypoint address:", error);
    }
  }
};

const clearWaypoint = (type: "start" | "end") => {
  const waypoint = routeStore.waypoints.find(
    (wp) =>
      wp.type === (type === "start" ? WaypointType.START : WaypointType.END)
  );

  if (waypoint) {
    routeStore.removeWaypoint(waypoint.id);

    if (type === "start") {
      startAddress.value = "";
    } else {
      endAddress.value = "";
    }
  }
};

const removeWaypoint = (id: string) => {
  routeStore.removeWaypoint(id);
};

const resetRoute = () => {
  routeStore.resetRoute();
  startAddress.value = "";
  endAddress.value = "";
};

const startFreehandDrawing = () => {
  isDrawing.value = true;
  // This would enable freehand drawing mode on the map
  // Not implemented in this example
};

const cancelFreehandDrawing = () => {
  isDrawing.value = false;
  // This would cancel freehand drawing mode
  // Not implemented in this example
};
</script>

<style scoped>
.waypoints-panel {
  overflow-y: auto;
}

:deep(.p-dropdown) {
  width: 100%;
}

:deep(.p-inputtext-sm) {
  font-size: 0.875rem;
  padding: 0.4rem 0.75rem;
}

:deep(.p-tabview-nav) {
  justify-content: center;
}

:deep(.p-tabview-nav li .p-tabview-nav-link) {
  padding: 0.75rem 1rem;
}
</style>

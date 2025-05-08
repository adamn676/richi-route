<template>
  <div class="p-4 space-y-4">
    <h2 class="text-lg font-bold">Waypoints</h2>

    <!-- Render each waypoint field -->
    <div
      v-for="(wp, idx) in waypointsWithMeta"
      :key="idx"
      class="flex items-center space-x-2"
    >
      <!-- The text input for forward geocoding -->
      <div class="relative flex-1">
        <input
          :placeholder="wp.placeholder"
          v-model="wp.address"
          @input="onInput(idx)"
          @focus="onFocus(idx)"
          @blur="onBlur(idx)"
          type="text"
          class="w-full px-3 py-2 border rounded"
        />

        <!-- 'X' button to clear text (but do not remove the marker) -->
        <button
          v-if="wp.address"
          class="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-500"
          @click="clearText(idx)"
        >
          &times;
        </button>

        <!-- Suggestions dropdown (simple example) -->
        <ul
          v-if="idx === activeIndex && showSuggestions && suggestions.length"
          class="absolute left-0 w-full border bg-white mt-1 z-10"
        >
          <li
            v-for="(s, sIdx) in suggestions"
            :key="sIdx"
            class="px-3 py-2 hover:bg-gray-100 cursor-pointer"
            @mousedown.prevent="selectSuggestion(s, idx)"
          >
            {{ s.label }}
          </li>
        </ul>
      </div>

      <!-- 'Remove' button only for via stops (not start or end) -->
      <button
        v-if="canRemove(idx)"
        class="text-red-600"
        @click="removeWaypoint(idx)"
      >
        Remove
      </button>
    </div>

    <!-- Add 'via stop' button below the list -->
    <button
      class="px-3 py-2 bg-gray-200 hover:bg-gray-300 rounded"
      @click="addIntermediateStop"
    >
      + Add Stop
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { storeToRefs } from "pinia";
import { forwardGeocode, type Place } from "@/services/maptiler.service";
import { useRouteStore } from "@/stores/route.store";

/**
 * We assume your route store has:
 *   - waypoints[] array of objects like { coords: [lng,lat], address: string, isMandatory: boolean, etc. }
 *   - methods for addWaypoint(), removeWaypoint(), updateWaypointAddress(), etc.
 */
const routeStore = useRouteStore();
const { waypoints } = storeToRefs(routeStore);

// Local state for suggestions
const suggestions = ref<Place[]>([]);
const showSuggestions = ref(false);
// Track which input is "active" (for showing the dropdown)
const activeIndex = ref<number | null>(null);

// Composables to transform your "waypoints" into data with placeholders, etc.
const waypointsWithMeta = computed(() => {
  // For this example, assume the first is always Start, last is End, and in-between are via stops
  return waypoints.value.map((wp, idx) => {
    let placeholder = "Via Stop";
    if (idx === 0) placeholder = "Start";
    if (idx === waypoints.value.length - 1 && waypoints.value.length >= 2)
      placeholder = "End";

    return {
      ...wp,
      placeholder,
    };
  });
});

/**
 * Called on every keystroke in a waypoint field => forward geocode
 * We'll do a small debounce (200-300ms) if you want.
 */
let debounceTimer: number;
function onInput(idx: number) {
  showSuggestions.value = true;
  activeIndex.value = idx;

  clearTimeout(debounceTimer);
  const query = (waypoints.value[idx].address ?? "").trim();

  debounceTimer = window.setTimeout(async () => {
    if (!query) {
      suggestions.value = [];
      return;
    }
    // call forwardGeocode
    suggestions.value = await forwardGeocode(query);
  }, 300);
}

// Show suggestions if we have some from a prior search
function onFocus(idx: number) {
  activeIndex.value = idx;
  if (suggestions.value.length) {
    showSuggestions.value = true;
  }
}

function onBlur(_idx: number) {
  // Delay hiding so user can click a suggestion
  setTimeout(() => {
    showSuggestions.value = false;
    activeIndex.value = null;
  }, 200);
}

/**
 * User clicked 'X' to clear text:
 * - Does NOT remove the marker or the waypoint
 * - Just clears the address field
 */
function clearText(idx: number) {
  if (idx < 0 || idx >= routeStore.waypoints.length) return;
  routeStore.waypoints[idx].address = "";
}

/**
 * When user selects a suggestion => update coords & address => recalc route
 */
async function selectSuggestion(place: Place, idx: number) {
  // Hide suggestions
  showSuggestions.value = false;
  activeIndex.value = null;
  suggestions.value = [];

  // Directly mutate store's waypoints
  if (idx >= 0 && idx < routeStore.waypoints.length) {
    routeStore.waypoints[idx].coords = place.coord;
    routeStore.waypoints[idx].address = place.label;
  }
}

/**
 * If not the first or last => we can remove
 */
function canRemove(idx: number) {
  return idx !== 0 && idx !== waypoints.value.length - 1;
}

/**
 * 'Remove' a via stop from the route
 */
function removeWaypoint(idx: number) {
  routeStore.removeWaypoint(idx);
}

/**
 * Insert a new waypoint right before the 'End'
 */
function addIntermediateStop() {
  // We'll say we insert a new empty waypoint at routeStore.waypoints.length - 1
  // e.g. { coords: [0,0], address: '', isMandatory: false }
  routeStore.insertIntermediateStop();
}
</script>

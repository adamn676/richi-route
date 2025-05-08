<!-- src/components/common/AddressSearchInput.vue -->
<template>
  <div class="relative custom-address-autocomplete w-full">
    <input
      ref="inputElement"
      type="text"
      :value="inputValue"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
      :placeholder="placeholder"
      :disabled="disabled || isGeocodingExternally"
      class="w-full px-3 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition duration-150 ease-in-out"
      :class="{
        'opacity-70 cursor-not-allowed': disabled || isGeocodingExternally,
      }"
      :aria-expanded="isSuggestionsVisible"
      aria-haspopup="listbox"
      :aria-activedescendant="activeSuggestionId"
      aria-autocomplete="list"
      :aria-controls="`suggestions-listbox-${waypointId}`"
      role="combobox"
    />
    <div
      v-if="internalIsGeocoding"
      class="absolute top-0 right-0 h-full flex items-center pr-2 pointer-events-none"
    >
      <ProgressSpinner
        style="width: 1.25rem; height: 1.25rem"
        strokeWidth="8"
        animationDuration=".8s"
      />
    </div>

    <ul
      v-if="isSuggestionsVisible && suggestions.length > 0"
      :id="`suggestions-listbox-${waypointId}`"
      role="listbox"
      class="absolute z-10 w-full bg-white border border-gray-300 rounded-md shadow-lg mt-1 max-h-60 overflow-y-auto"
    >
      <li
        v-for="(suggestion, index) in suggestions"
        :key="suggestion.label + index + waypointId"
        :id="`suggestion-${waypointId}-${index}`"
        role="option"
        :aria-selected="index === activeIndex"
        :class="[
          'flex items-center space-x-3 p-3 cursor-pointer hover:bg-indigo-50', // Main layout: flex row, spacing
          index === activeIndex ? 'bg-indigo-100' : '', // Highlight for active item
        ]"
        @mousedown.prevent="selectSuggestion(suggestion)"
        @mouseenter="activeIndex = index"
        @focusin="activeIndex = index"
        tabindex="-1"
      >
        <div class="flex-shrink-0 w-5 h-5 text-gray-500">
          <Icon :name="getIconForPlaceType(suggestion.kind)" size="5" />
        </div>

        <div class="flex-grow flex flex-col overflow-hidden">
          <span class="font-medium text-sm truncate">{{
            suggestion.label
          }}</span>
          <small
            v-if="
              suggestion.components?.region || suggestion.components?.country
            "
            class="text-gray-500 text-xs truncate"
          >
            {{
              [
                suggestion.components.place,
                suggestion.components.region,
                suggestion.components.country,
              ]
                .filter(Boolean)
                .join(", ")
            }}
          </small>
        </div>

        <div
          v-if="mapStore.isMapReady && formatDistance(suggestion.coord)"
          class="ml-auto pl-2 flex-shrink-0 text-xs text-gray-400"
        >
          ~ {{ formatDistance(suggestion.coord) }}
        </div>
      </li>
    </ul>
    <div
      v-else-if="
        isSuggestionsVisible &&
        inputValue.length >= 3 &&
        !internalIsGeocoding &&
        suggestions.length === 0
      "
      class="absolute z-10 w-full bg-white border border-gray-300 rounded-md shadow-lg mt-1 p-3 text-sm text-gray-500"
    >
      No results found for "{{ inputValue }}".
    </div>
    <div
      v-else-if="
        isSuggestionsVisible &&
        inputValue.length > 0 &&
        inputValue.length < 3 &&
        !internalIsGeocoding
      "
      class="absolute z-10 w-full bg-white border border-gray-300 rounded-md shadow-lg mt-1 p-3 text-sm text-gray-500"
    >
      Keep typing for suggestions...
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from "vue";
// Note: Still uses PrimeVue spinner. Replace if needed.
import ProgressSpinner from "primevue/progressspinner";
import { forwardGeocode, type Place } from "@/services/maptiler.service";
import debounce from "lodash/debounce";
import Icon from "@/components/ui/Icon.vue"; // Your custom Icon component
import { getIconForPlaceType } from "@/utils/placeIcons"; // Utility to get icon name
import { useMapStore } from "@/stores/map.store"; // For distance calculation
import * as turf from "@turf/turf"; // For distance calculation

interface Props {
  modelValue: string | undefined; // Input value via v-model
  waypointId: string; // Unique ID for ARIA attributes and keys
  placeholder?: string; // Input placeholder
  disabled?: boolean; // General disabled state from parent
  isGeocodingExternally?: boolean; // True if the store is geocoding this point (e.g. map click)
}

// Props definition with defaults
const props = withDefaults(defineProps<Props>(), {
  placeholder: "Search address...",
  disabled: false,
  isGeocodingExternally: false,
  modelValue: "", // Default modelValue if undefined passed
});

// Events emitted by the component
const emit = defineEmits([
  "update:modelValue", // For v-model
  "item-select", // When a suggestion is selected (payload: Place)
  "geocoding-status", // Internal loading status (payload: boolean)
  "text-submit", // When Enter is pressed on raw text (payload: string)
]);

// --- Reactive State ---
const inputValue = ref(props.modelValue ?? ""); // Internal copy of input value, always string
const suggestions = ref<Place[]>([]); // List of fetched suggestions
const isSuggestionsVisible = ref(false); // Controls visibility of the dropdown
const activeIndex = ref(-1); // Index of highlighted suggestion for keyboard nav
const internalIsGeocoding = ref(false); // True when THIS component is fetching
const inputElement = ref<HTMLInputElement | null>(null); // Ref for the HTML input element
const mapStore = useMapStore(); // Access map store for distance calculation

// --- Watchers ---
// Sync internal input value if prop changes externally
watch(
  () => props.modelValue,
  (newValue) => {
    const newPropValueAsString = newValue ?? "";
    if (newPropValueAsString !== inputValue.value) {
      inputValue.value = newPropValueAsString;
    }
  }
);

// --- Utility Functions ---
const log = (message: string) =>
  console.log(`AddressSearchInput (${props.waypointId}): ${message}`);

// Helper function to calculate and format distance from map center
const formatDistance = (
  placeCoords: number[] | undefined | null
): string | null => {
  log(
    `formatDistance called. Map Ready: ${
      mapStore.isMapReady
    }, Map Instance Exists: ${!!mapStore.mapInstance}`
  );

  if (
    !placeCoords ||
    !Array.isArray(placeCoords) ||
    placeCoords.length !== 2 ||
    typeof placeCoords[0] !== "number" ||
    typeof placeCoords[1] !== "number"
  ) {
    log(
      "-> formatDistance returning null (Invalid placeCoords provided):" +
        JSON.stringify(placeCoords)
    );
    return null;
  }
  if (!mapStore.isMapReady || !mapStore.mapInstance) {
    log("-> formatDistance returning null (Map not ready/instance missing)");
    return null;
  }

  try {
    const mapCenter = mapStore.mapInstance.getCenter();
    log(
      `Calculating distance from mapCenter: Lng=${mapCenter.lng}, Lat=${mapCenter.lat} to placeCoords: Lng=${placeCoords[0]}, Lat=${placeCoords[1]}`
    );
    const from = turf.point([mapCenter.lng, mapCenter.lat]);
    const to = turf.point(placeCoords);
    const distanceKm = turf.distance(from, to, { units: "kilometers" });
    log(` -> Calculated Distance (km): ${distanceKm}`);

    let formattedDistance: string;
    if (distanceKm < 1) {
      formattedDistance = `${Math.round(distanceKm * 1000)} m`;
    } else if (distanceKm < 100) {
      formattedDistance = `${distanceKm.toFixed(1)} km`;
    } else {
      formattedDistance = `${Math.round(distanceKm)} km`;
    }
    log(` -> Formatted Distance: ${formattedDistance}`);
    return formattedDistance;
  } catch (e) {
    console.error("Error calculating distance:", e);
    return null;
  }
};

// --- Geocoding Logic ---
const debouncedFetchSuggestions = debounce(async (query: string) => {
  if (props.isGeocodingExternally) {
    // Don't fetch if parent is already geocoding this point
    internalIsGeocoding.value = false;
    emit("geocoding-status", false);
    return;
  }
  if (!query || query.length < 3) {
    // Minimum query length
    suggestions.value = [];
    isSuggestionsVisible.value = query.length > 0; // Show "Keep typing..."
    internalIsGeocoding.value = false;
    emit("geocoding-status", false);
    return;
  }

  log(`Workspaceing suggestions for "${query}"`);
  internalIsGeocoding.value = true;
  emit("geocoding-status", true); // Inform parent
  isSuggestionsVisible.value = true; // Show list/loading state
  try {
    const places = await forwardGeocode(query);
    log(`Received ${places.length} suggestions for "${query}"`);
    // Avoid race conditions: Only update suggestions if the query hasn't changed
    if (internalIsGeocoding.value && inputValue.value === query) {
      suggestions.value = places;
      activeIndex.value = -1; // Reset highlight
    }
  } catch (error) {
    console.error(`Error fetching suggestions for "${query}":`, error);
    if (internalIsGeocoding.value && inputValue.value === query) {
      suggestions.value = []; // Clear suggestions on error
    }
  } finally {
    // Only reset loading state if this fetch corresponds to the current input value or query became too short
    // This prevents a slow request for "abc" finishing after user typed "abcd" and resetting loading state prematurely.
    if (inputValue.value === query || inputValue.value.length < 3) {
      log(`Finished geocoding for "${query}", internalIsGeocoding to false.`);
      internalIsGeocoding.value = false;
      emit("geocoding-status", false); // Inform parent
    } else {
      log(
        `Geocoding finished for older query ("${query}"), current query is "${inputValue.value}". Not resetting spinner yet.`
      );
    }

    // Update visibility based on current state AFTER loading potentially finished
    const stillHasFocus = document.activeElement === inputElement.value; // Check if input element still has focus
    log(`Still has focus? ${stillHasFocus}`);

    const oldVisFin = isSuggestionsVisible.value;

    if (!stillHasFocus) {
      log(`Input lost focus during/after fetch, hiding suggestions.`);
      isSuggestionsVisible.value = false;
    } else if (inputValue.value.length < 3) {
      isSuggestionsVisible.value = inputValue.value.length > 0; // Controls "Keep typing..." visibility
    } else {
      // If query >= 3 chars and still has focus, show list area (for results or "No results")
      isSuggestionsVisible.value = true;
    }
    if (oldVisFin !== isSuggestionsVisible.value)
      log(
        `Finally Block - set isSuggestionsVisible from ${oldVisFin} to ${isSuggestionsVisible.value}`
      );
    log(
      `Final state in FINALLY: isSuggestionsVisible = ${isSuggestionsVisible.value} (suggestions: ${suggestions.value.length})`
    );
  }
}, 500); // 500ms debounce

// --- Event Handlers ---
const onInput = (event: Event) => {
  const value = (event.target as HTMLInputElement).value;
  inputValue.value = value;
  emit("update:modelValue", value); // Update parent v-model
  if (value.trim()) {
    debouncedFetchSuggestions(value); // Fetch suggestions
  } else {
    debouncedFetchSuggestions.cancel(); // Cancel pending fetch if input cleared
    suggestions.value = [];
    isSuggestionsVisible.value = false;
    internalIsGeocoding.value = false;
    emit("geocoding-status", false);
  }
};

const onFocus = (event: FocusEvent) => {
  log("onFocus triggered.");
  const target = event.target as HTMLInputElement;
  target.select(); // Select current text

  // Show suggestions if available, or fetch if text is long enough
  if (
    inputValue.value.length >= 3 &&
    !internalIsGeocoding.value &&
    !props.isGeocodingExternally
  ) {
    debouncedFetchSuggestions(inputValue.value);
  } else if (inputValue.value.length > 0 || suggestions.value.length > 0) {
    isSuggestionsVisible.value = true;
  }
};

const onBlur = () => {
  log("onBlur triggered.");
  // Delay hiding to allow clicks on suggestions. Use a flag potentially set by mousedown on li.
  // Simple version: setTimeout. Refined version checks activeElement.
  setTimeout(() => {
    // Check if focus moved outside the component root div
    if (!inputElement.value?.parentElement?.contains(document.activeElement)) {
      log("onBlur timeout: Focus moved outside component. Hiding suggestions.");
      const oldVis = isSuggestionsVisible.value;
      isSuggestionsVisible.value = false;
      if (oldVis !== isSuggestionsVisible.value)
        log(
          `onBlur timeout - set isSuggestionsVisible from ${oldVis} to ${isSuggestionsVisible.value}`
        );
    } else {
      log(
        "onBlur timeout: Focus still inside component (likely on suggestion). Not hiding yet."
      );
    }
  }, 200); // Adjust delay if needed
};

// Called when clicking a suggestion
const selectSuggestion = (suggestion: Place) => {
  log(`selectSuggestion called for "${suggestion.label}".`);
  const label = suggestion.label;
  inputValue.value = label;
  emit("update:modelValue", label); // Update v-model
  emit("item-select", suggestion); // Inform parent of selection
  suggestions.value = []; // Clear suggestions
  isSuggestionsVisible.value = false; // Hide list
  internalIsGeocoding.value = false; // Ensure loading is off
  emit("geocoding-status", false);
};

// Handle keyboard navigation within the suggestions list
const onKeydown = (event: KeyboardEvent) => {
  const { key } = event;
  const suggestionsCount = suggestions.value.length;

  // Handle Enter key press
  if (key === "Enter") {
    event.preventDefault(); // Prevent form submission, etc.
    if (
      isSuggestionsVisible.value &&
      activeIndex.value >= 0 &&
      activeIndex.value < suggestionsCount
    ) {
      // If a suggestion is highlighted, select it
      selectSuggestion(suggestions.value[activeIndex.value]);
    } else if (inputValue.value.length >= 3) {
      // If no suggestion is highlighted but input has text, emit text-submit
      log("Enter pressed on raw text input.");
      emit("text-submit", inputValue.value);
      isSuggestionsVisible.value = false; // Hide list after submit
      activeIndex.value = -1;
    }
    return;
  }

  // Hide suggestions on Escape or Tab
  if (key === "Escape" || key === "Tab") {
    // event.preventDefault(); // Don't prevent default for Tab usually
    log(`onKeydown (${key}) - hiding suggestions.`);
    isSuggestionsVisible.value = false;
    activeIndex.value = -1;
    return;
  }

  // Handle Arrow keys only if suggestions are visible
  if (!isSuggestionsVisible.value || suggestionsCount === 0) {
    return;
  }

  switch (key) {
    case "ArrowDown":
      event.preventDefault();
      activeIndex.value = (activeIndex.value + 1) % suggestionsCount;
      scrollToActive();
      break;
    case "ArrowUp":
      event.preventDefault();
      activeIndex.value =
        (activeIndex.value - 1 + suggestionsCount) % suggestionsCount;
      scrollToActive();
      break;
  }
};

// --- Computed Properties ---
// ID for the currently highlighted suggestion (for ARIA)
const activeSuggestionId = computed(() => {
  if (activeIndex.value >= 0 && activeIndex.value < suggestions.value.length) {
    return `suggestion-${props.waypointId}-${activeIndex.value}`;
  }
  return undefined; // MUST be undefined if nothing is active
});

// --- Helper Methods ---
// Scroll the listbox to ensure the active item is visible
const scrollToActive = () => {
  const listbox = document.getElementById(
    `suggestions-listbox-${props.waypointId}`
  );
  const activeItem = activeSuggestionId.value
    ? document.getElementById(activeSuggestionId.value)
    : null;
  if (listbox && activeItem) {
    const { offsetTop } = activeItem;
    const itemHeight = activeItem.getBoundingClientRect().height;
    const { scrollTop, clientHeight: listboxClientHeight } = listbox;

    // Check if item is above the visible area
    if (offsetTop < scrollTop) {
      listbox.scrollTop = offsetTop;
    }
    // Check if item is below the visible area
    else if (offsetTop + itemHeight > scrollTop + listboxClientHeight) {
      listbox.scrollTop = offsetTop + itemHeight - listboxClientHeight;
    }
  }
};
</script>

<style scoped>
/* Basic input styling is now done with Tailwind utility classes on the <input> element */
/* Ensure the parent div has position relative for absolute positioning of suggestions */
.custom-address-autocomplete {
  position: relative;
}
</style>

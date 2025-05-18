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
          'flex items-center space-x-3 p-3 cursor-pointer hover:bg-indigo-50',
          index === activeIndex ? 'bg-indigo-100' : '',
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
import { ref, watch, computed, onUnmounted } from "vue"; // Added onUnmounted
import ProgressSpinner from "primevue/progressspinner";
import { forwardGeocode, type Place } from "@/services/maptiler.service";
import debounce from "lodash/debounce";
import Icon from "@/components/ui/Icon.vue";
import { getIconForPlaceType } from "@/utils/placeIcons";
import { useMapStore } from "@/stores/map.store";
import * as turf from "@turf/turf";

interface Props {
  modelValue: string | undefined;
  waypointId: string;
  placeholder?: string;
  disabled?: boolean;
  isGeocodingExternally?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: "Search address...",
  disabled: false,
  isGeocodingExternally: false,
  modelValue: "",
});

const emit = defineEmits([
  "update:modelValue",
  "item-select", // Emits the selected Place object
  "geocoding-status", // Emits boolean for internal loading
  "text-submit", // Emits the query string on Enter
]);

const inputValue = ref(props.modelValue ?? "");
const suggestions = ref<Place[]>([]);
const isSuggestionsVisible = ref(false);
const activeIndex = ref(-1);
const internalIsGeocoding = ref(false);
const inputElement = ref<HTMLInputElement | null>(null);
const mapStore = useMapStore();

const log = (message: string) =>
  console.log(`AddressSearchInput (${props.waypointId}): ${message}`);

watch(
  () => props.modelValue,
  (newValue) => {
    const newPropValueAsString = newValue ?? "";
    if (newPropValueAsString !== inputValue.value) {
      inputValue.value = newPropValueAsString;
    }
  },
  { immediate: true }
);

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
    const from = turf.point([mapCenter.lng, mapCenter.lat]);
    const to = turf.point(placeCoords);
    const distanceKm = turf.distance(from, to, { units: "kilometers" });
    let formattedDist;
    if (distanceKm < 1) {
      formattedDist = `${Math.round(distanceKm * 1000)} m`;
    } else if (distanceKm < 100) {
      formattedDist = `${distanceKm.toFixed(1)} km`;
    } else {
      formattedDist = `${Math.round(distanceKm)} km`;
    }
    log(` -> Formatted Distance: ${formattedDist}`);
    return formattedDist;
  } catch (e) {
    console.error("Error calculating distance:", e);
    return null;
  }
};

const debouncedFetchSuggestions = debounce(async (query: string) => {
  if (props.isGeocodingExternally) {
    internalIsGeocoding.value = false;
    emit("geocoding-status", false);
    return;
  }
  if (!query || query.length < 3) {
    suggestions.value = [];
    isSuggestionsVisible.value = query.length > 0;
    internalIsGeocoding.value = false;
    emit("geocoding-status", false);
    return;
  }

  log(`Workspaceing suggestions for "${query}"`);
  internalIsGeocoding.value = true;
  emit("geocoding-status", true);
  isSuggestionsVisible.value = true;
  try {
    const places = await forwardGeocode(query);
    log(`Received ${places.length} suggestions for "${query}"`);
    if (internalIsGeocoding.value && inputValue.value === query) {
      suggestions.value = places;
      activeIndex.value = -1;
    }
  } catch (error) {
    console.error(`Error fetching suggestions for "${query}":`, error);
    if (internalIsGeocoding.value && inputValue.value === query) {
      suggestions.value = [];
    }
  } finally {
    if (inputValue.value === query || inputValue.value.length < 3) {
      log(`Finished geocoding for "${query}", internalIsGeocoding to false.`);
      internalIsGeocoding.value = false;
      emit("geocoding-status", false);
    } else {
      log(
        `Geocoding finished for older query ("${query}"), current query is "${inputValue.value}". Not resetting spinner yet.`
      );
    }
    const stillHasFocus = document.activeElement === inputElement.value;
    if (!stillHasFocus) {
      isSuggestionsVisible.value = false;
    } else if (inputValue.value.length < 3) {
      isSuggestionsVisible.value = inputValue.value.length > 0;
    } else {
      isSuggestionsVisible.value = true;
    }
    log(
      `Final state in FINALLY: isSuggestionsVisible = ${isSuggestionsVisible.value} (suggestions: ${suggestions.value.length})`
    );
  }
}, 500);

const onInput = (event: Event) => {
  const value = (event.target as HTMLInputElement).value;
  inputValue.value = value;
  emit("update:modelValue", value);
  if (value.trim()) {
    debouncedFetchSuggestions(value);
  } else {
    debouncedFetchSuggestions.cancel();
    suggestions.value = [];
    isSuggestionsVisible.value = false;
    internalIsGeocoding.value = false;
    emit("geocoding-status", false);
  }
};

const onFocus = (event: FocusEvent) => {
  log("onFocus triggered.");
  const target = event.target as HTMLInputElement;
  target.select();
  if (
    inputValue.value.length >= 3 &&
    !internalIsGeocoding.value &&
    !props.isGeocodingExternally
  ) {
    debouncedFetchSuggestions(inputValue.value);
  } else if (inputValue.value.length > 0 || suggestions.value.length > 0) {
    isSuggestionsVisible.value = true; // Show existing suggestions or "Keep typing"
  }
};

const onBlur = () => {
  log("onBlur triggered.");
  setTimeout(() => {
    if (!inputElement.value?.parentElement?.contains(document.activeElement)) {
      log("onBlur timeout: Focus moved outside component. Hiding suggestions.");
      isSuggestionsVisible.value = false;
    }
  }, 200);
};

const selectSuggestion = (suggestion: Place) => {
  log(`selectSuggestion called for "${suggestion.label}".`);
  const label = suggestion.label;
  inputValue.value = label;
  emit("update:modelValue", label);
  emit("item-select", suggestion); // Crucial emit for parent
  suggestions.value = [];
  isSuggestionsVisible.value = false;
  internalIsGeocoding.value = false;
  emit("geocoding-status", false);
};

const onKeydown = (event: KeyboardEvent) => {
  const { key } = event;
  const suggestionsCount = suggestions.value.length;

  if (key === "Enter") {
    event.preventDefault();
    if (
      isSuggestionsVisible.value &&
      activeIndex.value >= 0 &&
      activeIndex.value < suggestionsCount
    ) {
      selectSuggestion(suggestions.value[activeIndex.value]);
    } else if (inputValue.value.length >= 3) {
      emit("text-submit", inputValue.value);
      isSuggestionsVisible.value = false;
      activeIndex.value = -1;
    }
    return;
  }
  if (key === "Escape" || key === "Tab") {
    isSuggestionsVisible.value = false;
    activeIndex.value = -1;
    if (key === "Escape") event.preventDefault(); // Prevent other escape actions
    return;
  }
  if (!isSuggestionsVisible.value || suggestionsCount === 0) return;

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

const activeSuggestionId = computed(() => {
  if (activeIndex.value >= 0 && activeIndex.value < suggestions.value.length) {
    return `suggestion-${props.waypointId}-${activeIndex.value}`;
  }
  return undefined;
});

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
    if (offsetTop < scrollTop) {
      listbox.scrollTop = offsetTop;
    } else if (offsetTop + itemHeight > scrollTop + listboxClientHeight) {
      listbox.scrollTop = offsetTop + itemHeight - listboxClientHeight;
    }
  }
};

onUnmounted(() => {
  debouncedFetchSuggestions.cancel();
});
</script>

<style scoped>
.custom-address-autocomplete {
  position: relative;
}
</style>

<template>
  <div class="relative w-full">
    <!-- 1) The input, bound to searchQuery -->
    <input
      ref="inputRef"
      v-model="searchQuery"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      type="text"
      placeholder="Search for address or POI"
      class="w-full px-4 py-2 border rounded"
    />

    <!-- 2) Clear button (only when there’s text) -->
    <button
      v-if="searchQuery"
      @click="clearSearch"
      class="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-500 hover:text-gray-700"
      aria-label="Clear"
    >
      &times;
    </button>

    <!-- 3) Suggestions dropdown -->
    <ul
      v-if="showSuggestions && suggestions.length"
      class="relative z-10 bg-white border mt-1 w-full overflow-auto rounded"
    >
      <li
        v-for="item in suggestions"
        :key="item.raw.id"
        @mousedown.prevent="selectSuggestion(item)"
        class="px-3 py-2 hover:bg-gray-100 flex justify-between items-center cursor-pointer"
      >
        <!-- Icon based on place type -->
        <div class="mr-3 flex-shrink-0">
          <Icon
            :name="getIconForPlaceType(item)"
            :svgClass="`icon-${getIconClassForPlaceType(item)}`"
          />
        </div>

        <!-- Custom formatted address -->
        <div class="flex flex-col flex-grow">
          <span class="font-medium">{{ formatMainAddressPart(item) }}</span>
          <span class="text-xs text-gray-500">{{
            formatSecondaryAddressPart(item)
          }}</span>
        </div>
        <!-- <span
          class="ml-2 text-xs font-semibold px-2 py-0.5 rounded"
          :class="{
            'bg-blue-100 text-blue-800': item.kind === 'address',
            'bg-yellow-100 text-yellow-800': item.kind === 'road',
            'bg-green-100 text-green-800': item.kind === 'poi',
            'bg-purple-100 text-purple-800':
              item.kind === 'place' || item.kind === 'region',
          }"
        >
          {{ kindLabels[item.kind] || item.kind }}
        </span> -->
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { forwardGeocode, type Place } from "@/services/maptiler.service";
import { useRouteStore } from "@/stores/route.store";
import Icon from "./Icon.vue";

const routeStore = useRouteStore();

// reactive state
const inputRef = ref<HTMLInputElement | null>(null);
const searchQuery = ref("");
const suggestions = ref<Place[]>([]);
const showSuggestions = ref(false);
let debounceTimer: number;

// pretty names for your badges
const kindLabels: Record<string, string> = {
  address: "Address",
  road: "Road",
  poi: "POI",
  place: "Place",
  region: "Region",
};

/** Triggered on every keystroke */
function onInput() {
  showSuggestions.value = true;

  clearTimeout(debounceTimer);
  const query = searchQuery.value.trim();
  debounceTimer = window.setTimeout(async () => {
    if (!query) {
      suggestions.value = [];
      return;
    }
    suggestions.value = await forwardGeocode(query);
  }, 300);
}

/** Re‑open the dropdown if there are suggestions */
function onFocus() {
  if (suggestions.value.length) {
    showSuggestions.value = true;
  }
}

/** Hide after a tiny delay so mousedown can fire */
function onBlur() {
  setTimeout(() => {
    showSuggestions.value = false;
  }, 100);
}

/**
 * Format the main part of the address based on the place type
 */
function formatMainAddressPart(place: Place): string {
  const c = place.components;

  // For addresses (with house number)
  if (place.kind === "address" && c.house_number && c.street) {
    return `${c.street} ${c.house_number}`;
  }

  // For roads
  if (place.kind === "road" && c.street) {
    return c.street;
  }

  // For POIs, use the original label as it usually contains the POI name
  if (place.kind === "poi") {
    // You could extract the POI name from the raw data if needed
    return place.label.split(",")[0];
  }

  // For places and regions
  if (["place", "region", "locality", "neighbourhood"].includes(place.kind)) {
    return place.label.split(",")[0];
  }

  // Default: first part of the label
  return place.label.split(",")[0];
}

/**
 * Format the secondary part of the address (city, region, country)
 */
function formatSecondaryAddressPart(place: Place): string {
  const c = place.components;
  const parts = [];

  // Prioritize municipal_district over place/neighborhood
  if (c.municipal_district) {
    parts.push(c.municipal_district);
  } else if (c.place) {
    parts.push(c.place);
  } else if (c.locality) {
    parts.push(c.locality);
  }

  // Add county/city if not already included
  if (c.county && !parts.includes(c.county)) {
    parts.push(c.county);
  }

  // Add region
  if (c.region && !parts.includes(c.region)) {
    parts.push(c.region);
  }

  // Add country if available and not already included
  if (c.country && parts.length < 2) {
    parts.push(c.country);
  }

  // Add postal code at the beginning if available
  if (c.postal_code) {
    return `${c.postal_code} ${parts.join(", ")}`;
  }

  return parts.join(", ");
}

/**
 * Get the appropriate icon name for each place type
 */
function getIconForPlaceType(place: Place): string {
  const poiTypes = place.raw?.properties?.category;

  // For address
  if (place.kind === "address") {
    return "pin";
  }

  // For road
  if (place.kind === "road") {
    return "directions";
  }

  // For POIs, use a more specific icon if available
  if (place.kind === "poi") {
    // Check for common POI types
    // if (poiTypes) {
    //   // You can add more mappings here based on the categories returned by MapTiler
    //   const poiIconMap: Record<string, string> = {
    //     food: "restaurant",
    //     restaurant: "restaurant",
    //     cafe: "coffee",
    //     hotel: "hotel",
    //     lodging: "hotel",
    //     shopping: "shopping_cart",
    //     store: "store",
    //     gas_station: "local_gas_station",
    //     hospital: "local_hospital",
    //     pharmacy: "local_pharmacy",
    //     bank: "account_balance",
    //     school: "school",
    //     university: "school",
    //     bar: "sports_bar",
    //     parking: "local_parking",
    //     museum: "museum",
    //     park: "park",
    //   };

    //   for (const type of Array.isArray(poiTypes) ? poiTypes : [poiTypes]) {
    //     if (poiIconMap[type]) {
    //       return poiIconMap[type];
    //     }
    //   }
    // }
    return "poi";

    // Default POI icon
    // return "place";
  }

  // For places and regions
  if (place.kind === "place") {
    return "location_city";
  }

  if (place.kind === "region") {
    return "terrain";
  }

  // Default
  return "location_on";
}

/**
 * Get appropriate CSS classes for the icon based on place type
 */
function getIconClassForPlaceType(place: Place): string {
  const baseClass = "w-5 h-5";

  // Add color based on type
  if (place.kind === "address") {
    return `${baseClass} text-blue-600`;
  }

  if (place.kind === "road") {
    return `${baseClass} text-yellow-600`;
  }

  if (place.kind === "poi") {
    return `${baseClass} text-green-600`;
  }

  if (place.kind === "place" || place.kind === "region") {
    return `${baseClass} text-purple-600`;
  }

  return `${baseClass} text-gray-600`;
}

/** Clears everything out */
function clearSearch() {
  searchQuery.value = "";
  suggestions.value = [];
  showSuggestions.value = false;
  inputRef.value?.focus();
}

/** User clicked a suggestion */
async function selectSuggestion(item: Place) {
  searchQuery.value = item.label;
  suggestions.value = [];
  showSuggestions.value = false;
  await routeStore.addPlace(item);
}
</script>

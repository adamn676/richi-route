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
      class="absolute z-10 bg-white border mt-1 w-full max-h-60 overflow-auto rounded"
    >
      <li
        v-for="item in suggestions"
        :key="item.raw.id"
        @mousedown.prevent="selectSuggestion(item)"
        class="px-3 py-2 hover:bg-gray-100 flex justify-between items-center cursor-pointer"
      >
        <span>{{ item.label }}</span>
        <span
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
        </span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { forwardGeocode, type Place } from "@/services/maptiler.service";
import { useRouteStore } from "@/stores/route.store";

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

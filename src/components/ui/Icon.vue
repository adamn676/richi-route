<template>
  <svg
    v-if="pathData"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    :class="[svgClass, `icon-${name}`]"
    aria-hidden="true"
  >
    <path :d="pathData" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { materialIcons } from "@/icons/materialIcons";

// Props for the Icon component
const props = defineProps({
  name: { type: String, required: true },
  svgClass: { type: String, default: "w-5 h-5" }, // default sizing
});

// Return the path data for the requested icon name
const pathData = computed(() => materialIcons[props.name] || null);
</script>

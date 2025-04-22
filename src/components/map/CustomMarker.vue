<!-- src/components/map/CustomMarker.vue -->
<template>
  <div class="marker-container">
    <!-- Pin shape that gets rotated -->
    <div
      class="marker-pin"
      :class="[`marker-${type}`, interactive ? 'interactive' : '']"
    >
      <div class="marker-content">
        <Icon v-if="icon" :name="icon" :svgClass="`icon-in-marker`" />
      </div>
    </div>

    <!-- Number badge that stays upright -->
    <div v-if="number !== undefined" class="marker-number">{{ number }}</div>
  </div>
</template>

<script setup lang="ts">
import Icon from "@/components/ui/Icon.vue";
import { computed } from "vue";

const props = defineProps({
  type: {
    type: String,
    default: "waypoint",
    validator: (val: string) => ["waypoint", "shaping"].includes(val),
  },
  icon: {
    type: String,
    default: "",
  },
  size: {
    type: Number,
    default: 32,
  },
  iconSize: {
    type: Number,
    default: 16, // Actual pixels now
  },
  iconColor: {
    type: String,
    default: "text-white",
  },
  number: {
    type: Number,
    default: undefined,
  },
  interactive: {
    type: Boolean,
    default: true,
  },
});

// Convert iconSize to actual pixel size
const iconSizePx = computed(() => {
  return props.iconSize;
});
</script>

<style scoped>
/* Container for both pin and number */
.marker-container {
  position: absolute;
  /* Center the pin tip at the exact coordinate */
  transform: translate(0, 0);
}

/* The actual pin shape */
.marker-pin {
  width: 30px;
  height: 30px;
  border-radius: 50% 50% 50% 0;
  background: #818cf8;
  border: 2px solid #312e81;
  transform: rotate(-45deg);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 3px 6px rgba(0, 0, 0, 0.3);
  cursor: grab;

  /* Position relative to container */
  position: absolute;
  left: -15px; /* Half the width */
  top: -30px; /* Full height */
}

.marker-content {
  /* Keep icon upright inside rotated pin */
  transform: rotate(45deg);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

/* Style for the icon inside marker */
.icon-in-marker {
  color: white;
  display: block;
}

.marker-waypoint {
  background: #818cf8; /* Indigo-400 - matches route interior */
  border: 2px solid #312e81; /* Indigo-900 - matches route border */
  .marker-content {
    padding-top: 3px;
  }
}

.marker-shaping {
  background: #c7d2fe; /* Indigo-200 - matches hover color */
  border: 2px solid #4f46e5; /* Indigo-600 - medium indigo */
  width: 24px;
  height: 24px;
  left: -12px;
  top: -24px;
}

.interactive:hover {
  transform: rotate(-45deg) scale(1.1);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.4);
}

/* Number badge - positioned independently, not rotated */
.marker-number {
  position: absolute;
  /* Position it above and to the right of the pin */
  top: -38px;
  right: -24px;
  background: #312e81;
  color: white;
  border-radius: 50%;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: bold;
  border: 2px solid white;
  /* No transform - stays upright */
}
</style>

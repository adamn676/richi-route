<template>
  <div class="debug-controls p-2 bg-gray-700 bg-opacity-50 rounded fixed bottom-4 right-4 z-50">
    <Button :label="buttonLabel" :icon="buttonIcon" @click="toggleDebug" :severity="debugStore.showDebugVisuals ? 'success' : 'warning'" size="small" />
    <div v-if="debugStore.showDebugVisuals" class="mt-2 p-2 bg-gray-800 rounded text-xs">
      <p><strong>Last ORS Request:</strong></p>
      <pre class="overflow-auto max-h-32">{{ JSON.stringify(debugStore.lastOrsRequest, null, 2) }}</pre>
      <p class="mt-1"><strong>Last ORS Response:</strong></p>
      <pre class="overflow-auto max-h-32">{{ JSON.stringify(debugStore.lastOrsResponse, null, 2) }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useDebugStore } from '@/stores/debug.store';
import Button from 'primevue/button'; // Using PrimeVue button

const debugStore = useDebugStore();

const toggleDebug = () => {
  debugStore.toggleDebugVisuals();
};

const buttonLabel = computed(() => {
  return debugStore.showDebugVisuals ? 'Hide Debug Visuals' : 'Show Debug Visuals';
});

const buttonIcon = computed(() => {
  return debugStore.showDebugVisuals ? 'pi pi-eye-slash' : 'pi pi-eye';
});
</script>

<style scoped>
.debug-controls {
  /* Basic styling, adjust as needed */
  color: white;
}
pre {
  white-space: pre-wrap; /* Ensure text wraps */
  word-wrap: break-word; /* Break long words */
  background-color: #2d3748; /* Slightly different bg for pre */
  padding: 0.5rem;
  border-radius: 0.25rem;
}
</style>

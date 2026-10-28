<template>
  <div class="map-navigation">
    <!-- Shown once the map is turned or tilted; the needle points north. -->
    <v-map-button v-if="turned" v-tooltip:start="'Nach Norden ausrichten'" aria-label="Nach Norden ausrichten" @click="map?.resetNorthPitch()">
      <IconNavigationNorth :size="20" aria-hidden="true" :style="{ transform: `rotate(${-bearing}deg)` }" />
    </v-map-button>
    <v-btn-group class="map-navigation__zoom" direction="vertical" divided rounded="lg" elevation="2">
      <v-btn v-tooltip:start="'Vergrößern'" icon color="surface" size="40" aria-label="Vergrößern" @click="map?.zoomIn()">
        <IconPlus :size="20" aria-hidden="true" />
      </v-btn>
      <v-btn v-tooltip:start="'Verkleinern'" icon color="surface" size="40" aria-label="Verkleinern" @click="map?.zoomOut()">
        <IconMinus :size="20" aria-hidden="true" />
      </v-btn>
    </v-btn-group>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Map } from 'maplibre-gl';
import { IconMinus, IconNavigationNorth, IconPlus } from '@/components/icons';

const props = defineProps<{ map: Map | null }>();
const bearing = ref(0), pitch = ref(0);
const turned = computed(() => Math.abs(bearing.value) >= .5 || pitch.value >= .5);
watch(() => props.map, (instance, _, onCleanup) => {
  if (!instance) return;
  const update = () => { bearing.value = instance.getBearing(); pitch.value = instance.getPitch(); };
  update();
  const subscriptions = [instance.on('rotate', update), instance.on('pitch', update)];
  onCleanup(() => subscriptions.forEach(subscription => subscription.unsubscribe()));
});
</script>

<style scoped>
.map-navigation { display: grid; justify-items: end; gap: .5rem; }
/* Phones zoom with two fingers, and their short map needs the room for the tools above. */
@media (max-width: 760px) { .map-navigation__zoom { display: none; } }
</style>

<template>
  <section class="street-view" aria-label="Street View" @keydown.esc="streetView.close()">
    <iframe :src="streetView.src ?? undefined" title="Google Street View" allowfullscreen referrerpolicy="no-referrer-when-downgrade" />
    <v-map-button ref="closeButton" v-tooltip:bottom="'Street View schließen'" class="street-view__close" aria-label="Street View schließen"
      @click="streetView.close()">
      <IconX :size="20" aria-hidden="true" />
    </v-map-button>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconX } from '@/components/icons';
import { useStreetViewStore } from '@/stores/street-view.store';
import { useRouteProfileStore } from '@/stores/route-profile.store';

const streetView = useStreetViewStore();
const profile = useRouteProfileStore();
const closeButton = ref<{ $el: HTMLElement }>();
// Focus starts on the close button, so Escape or Enter closes at once.
onMounted(() => closeButton.value?.$el.focus());
// The elevation profile marks the spot on the route while Street View shows it.
watch(() => streetView.routeDistance, distance => profile.restAt(distance), { immediate: true });
onBeforeUnmount(() => profile.restAt(null));
</script>

<style scoped>
.street-view { position: absolute; inset: 0; z-index: 10; background: #000; }
iframe { display: block; width: 100%; height: 100%; border: 0; }
/* Beside Google's fullscreen button (40 px, 10 px from the corner), not on top of it. */
.street-view__close { position: absolute; top: 10px; right: 60px; }
</style>

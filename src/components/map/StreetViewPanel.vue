<template>
  <section class="street-view" aria-label="Street View" @keydown.esc="streetView.close()">
    <iframe :src="streetView.src ?? undefined" title="Google Street View" allowfullscreen referrerpolicy="no-referrer-when-downgrade" />
    <button ref="closeButton" type="button" class="btn btn--icon btn--map street-view__close" aria-label="Street View schließen"
      title="Street View schließen" @click="streetView.close()">
      <IconX :size="20" aria-hidden="true" />
    </button>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { IconX } from '@/components/icons';
import { useStreetViewStore } from '@/stores/street-view.store';

const streetView = useStreetViewStore();
const closeButton = ref<HTMLButtonElement>();
// Focus starts on the close button, so Escape or Enter closes at once.
onMounted(() => closeButton.value?.focus());
</script>

<style scoped>
.street-view { position: absolute; inset: 0; z-index: 10; background: #000; }
iframe { display: block; width: 100%; height: 100%; border: 0; }
.street-view__close { position: absolute; top: .75rem; right: .75rem; }
@media (max-width: 760px) { .street-view__close { top: .5rem; right: .5rem; } }
</style>

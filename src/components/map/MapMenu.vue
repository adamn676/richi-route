<template>
  <div ref="root" class="map-menu">
    <!-- Rendered in place: the panel stays within the map, and Tab moves from the button into it. The button's tooltip
         hides while the menu is open, so the first Escape closes the menu. -->
    <v-menu v-model="open" :attach="root" location="start top" offset="8" :close-on-content-click="false">
      <template #activator="{ props: menu }">
        <v-map-button v-bind="menu" v-tooltip:start="{ text: title ?? heading, disabled: open }" class="map-menu__trigger" :active="open" :aria-label="label">
          <slot name="icon" />
        </v-map-button>
      </template>
      <v-card class="map-menu__panel" role="dialog" :aria-label="heading">
        <v-card-item :title="heading">
          <template #append>
            <v-icon-button aria-label="Schließen" @click="close"><IconX :size="16" aria-hidden="true" /></v-icon-button>
          </template>
        </v-card-item>
        <v-card-text class="pt-0"><slot :close="close" /></v-card-text>
      </v-card>
    </v-menu>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { IconX } from '@/components/icons';

defineProps<{ label: string; heading: string; title?: string }>();
const open = ref(false);
const root = ref<HTMLElement>();
// The menu returns focus to its button as it closes.
const close = () => { open.value = false; };
</script>

<style scoped>
.map-menu__panel { width: min(18rem, calc(100vw - 5rem)); max-height: min(60dvh, 28rem); overflow-y: auto; }
/* Each choice fills its row, which shows hover as a Material menu item does, instead of the control's small halo. */
.map-menu__panel :deep(.v-selection-control) { border-radius: var(--radius); }
.map-menu__panel :deep(.v-selection-control:hover) { background: rgba(var(--v-theme-on-surface), var(--v-hover-opacity)); }
.map-menu__panel :deep(.v-selection-control__input:hover::before) { opacity: 0; }
.map-menu__panel :deep(.v-selection-control .v-label) { flex: 1; align-self: stretch; }
/* Stays within the map above the phone sheet. */
@media (max-width: 760px) { .map-menu__panel { max-height: calc(50dvh - 7rem); } }
</style>

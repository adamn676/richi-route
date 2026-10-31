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
        <div class="section-heading">
          <h2 class="text-title-medium">{{ heading }}</h2>
          <v-icon-button aria-label="Schließen" @click="close"><IconX :size="18" aria-hidden="true" /></v-icon-button>
        </div>
        <slot :close="close" />
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
/* Laid out as a sidebar section: the heading's capitals 24 px under the top, margins of 20 px, the content 16 px under
   the heading's baseline and 24 px above the bottom, measured to what shows. */
.map-menu__panel { width: min(18rem, calc(100vw - 5rem)); max-height: min(60dvh, 28rem); overflow-y: auto;
  padding: var(--space-3) var(--gutter) calc(var(--space-6) - 11px); }
.map-menu__panel > .section-heading { margin-bottom: 0; }
/* A choice first under the heading: its glyph, which its row puts 11 px down, 16 px under the baseline as well. */
.map-menu__panel > .section-heading + :deep(.v-input:not(.v-radio-group)) { margin-top: -7px; }
/* Each choice a 40 px row: its glyph on the margin, its label on the sidebar's text column
   36 px in; hover fills the row 8 px past the content, as the sidebar's rows do, instead of the control's small halo. */
.map-menu__panel :deep(.v-selection-control) { width: calc(100% + 2 * var(--space-2)); margin-inline: calc(-1 * var(--space-2));
  padding-inline: var(--space-2); border-radius: var(--radius); }
.map-menu__panel :deep(.v-selection-control:hover) { background: rgba(var(--v-theme-on-surface), var(--v-hover-opacity)); }
.map-menu__panel :deep(.v-selection-control__wrapper) { width: 39px; height: 40px; margin-left: -3px; justify-content: flex-start; }
.map-menu__panel :deep(.v-selection-control__input) { width: 24px; height: 24px; }
/* Material's radio ring is drawn 2 px into its icon, a checkbox's square 3 px. */
.map-menu__panel :deep(.v-radio .v-selection-control__wrapper) { width: 38px; margin-left: -2px; }
.map-menu__panel :deep(.v-selection-control__input:hover::before) { opacity: 0; }
.map-menu__panel :deep(.v-selection-control .v-label) { flex: 1; align-self: stretch; font-size: .875rem; line-height: 1.25rem; }
/* A group's name as the sidebar's small labels, on the margin. */
.map-menu__panel :deep(:is(.v-radio-group > .v-input__control > .v-label, .map-menu__group)) { display: block; margin: 0; color: var(--text-muted); font-size: .75rem; opacity: 1; }
.map-menu__panel :deep(.v-selection-control-group) { margin-top: 0; padding: 0; }
</style>

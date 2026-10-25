<template>
  <main class="editor-layout" :class="{ 'editor-layout--collapsed': collapsed }">
    <AppSidebar id="sidebar" class="editor-layout__sidebar" />
    <MapView class="editor-layout__map" />
    <!-- Folds the sidebar away so the map gets the full width. -->
    <button type="button" class="editor-layout__toggle" :aria-label="toggleLabel" :title="toggleLabel"
      :aria-expanded="!collapsed" aria-controls="sidebar" @click="collapsed = !collapsed">
      <component :is="collapsed ? IconChevronRight : IconChevronLeft" :size="16" aria-hidden="true" />
    </button>
  </main>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppSidebar from "@/components/layout/AppSidebar.vue";
import MapView from "@/components/map/MapView.vue";
import { IconChevronLeft, IconChevronRight } from '@/components/icons';

const storageKey = 'richiroute.sidebar-collapsed';
const collapsed = ref((() => { try { return localStorage.getItem(storageKey) === '1'; } catch { return false; } })());
const toggleLabel = computed(() => collapsed.value ? 'Seitenleiste einblenden' : 'Seitenleiste ausblenden');
watch(collapsed, value => { try { localStorage.setItem(storageKey, value ? '1' : '0'); } catch { /* Storage may be disabled. */ } });
</script>

<style scoped>
/* Narrower on small laptops, wider on large screens. */
.editor-layout {
  --sidebar-width: clamp(22rem, 10.4rem + 15vw, 26rem);
  position: relative;
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  width: 100%;
  height: 100dvh;
  overflow: hidden;
}
.editor-layout--collapsed { --sidebar-width: 0px; }
.editor-layout--collapsed .editor-layout__sidebar { visibility: hidden; }
.editor-layout__sidebar { min-width: 0; min-height: 0; overflow: hidden; border-right: 1px solid var(--border); }
.editor-layout__map { min-width: 0; }
/* A tab on the sidebar's edge, halfway down the map. */
.editor-layout__toggle {
  position: absolute; top: 50%; left: var(--sidebar-width); z-index: 20; display: grid; place-items: center;
  width: 1.25rem; height: 3rem; padding: 0; border: 1px solid var(--border); border-left: 0; border-radius: 0 var(--radius) var(--radius) 0;
  background: var(--surface); color: var(--text-muted); box-shadow: var(--shadow); cursor: pointer; transform: translateY(-50%);
}
.editor-layout__toggle:hover { color: var(--text); }
@media (max-width: 760px) {
  .editor-layout, .editor-layout--collapsed { grid-template-columns: minmax(0, 1fr); grid-template-rows: 50dvh minmax(0, 1fr); }
  .editor-layout--collapsed .editor-layout__sidebar { visibility: visible; }
  .editor-layout__map { grid-row: 1; }
  .editor-layout__sidebar { border-right: 0; border-top: 1px solid var(--border); }
  .editor-layout__toggle { display: none; }
  /* Typing gets the whole screen, so the keyboard does not cover the field and its suggestions. */
  .editor-layout:has(.editor-layout__sidebar input.field:focus) { grid-template-rows: 0 minmax(0, 1fr); }
}
</style>

<template>
  <main class="editor-layout">
    <AppSidebar class="editor-layout__sidebar" />
    <MapView class="editor-layout__map" />
  </main>
</template>

<script setup lang="ts">
import AppSidebar from "@/components/layout/AppSidebar.vue";
import MapView from "@/components/map/MapView.vue";
</script>

<style scoped>
.editor-layout {
  display: grid;
  grid-template-columns: 24rem minmax(0, 1fr);
  width: 100%;
  height: 100dvh;
  overflow: hidden;
}
.editor-layout__sidebar { min-height: 0; border-right: 1px solid var(--border); }
.editor-layout__map { min-width: 0; }
@media (max-width: 760px) {
  .editor-layout { grid-template-columns: 1fr; grid-template-rows: 50dvh minmax(0, 1fr); }
  .editor-layout__map { grid-row: 1; }
  .editor-layout__sidebar { border-right: 0; border-top: 1px solid var(--border); }
  /* Typing gets the whole screen, so the keyboard does not cover the field and its suggestions. */
  .editor-layout:has(.editor-layout__sidebar input.field:focus) { grid-template-rows: 0 minmax(0, 1fr); }
}
</style>

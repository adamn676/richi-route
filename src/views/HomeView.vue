<!-- src/views/HomeView.vue -->
<template>
  <main class="editor-layout">
    <AppSidebar class="editor-layout__sidebar" />
    <section class="editor-layout__map">
      <MapView />
      <a class="editor-layout__compare" href="http://127.0.0.1:5174/" target="_blank" rel="noopener">
        Routen vergleichen
      </a>
    </section>
  </main>
</template>

<script setup lang="ts">
import AppSidebar from "@/components/layout/AppSidebar.vue";
import MapView from "@/components/map/MapView.vue";


</script>

<style scoped>
.editor-layout {
  display: grid;
  grid-template-columns: minmax(335px, 380px) minmax(0, 1fr);
  width: 100%;
  height: 100dvh;
  overflow: hidden;
}
.editor-layout__sidebar { overflow-y: auto; background: #f3f7f5; border-right: 1px solid #e3eae7; }
.editor-layout__map { position: relative; min-width: 0; min-height: 0; }
.editor-layout__compare { position: absolute; top: 1rem; right: 1rem; z-index: 2; padding: .6rem .75rem; border: 1px solid #cddbd9; border-radius: .4rem; background: #fff; color: #16515a; font-size: .8rem; font-weight: 700; text-decoration: none; box-shadow: 0 2px 12px #19343c26; }
.editor-layout__compare:hover { background: #e9f5f1; }
.editor-layout__compare:focus-visible { outline: 2px solid #086c78; outline-offset: 2px; }
@media (max-width: 760px) {
  .editor-layout { grid-template-columns: 1fr; grid-template-rows: minmax(250px, 43dvh) minmax(0, 1fr); }
  .editor-layout__sidebar { border-right: 0; border-bottom: 1px solid #e3eae7; }
  .editor-layout__compare { top: auto; bottom: 2rem; left: .75rem; right: auto; }
}
</style>

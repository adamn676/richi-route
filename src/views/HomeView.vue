<!-- src/views/HomeView.vue -->
<template>
  <div class="flex h-full">
    <AppSidebar class="w-1/4" />
    <section class="flex-1">
      <MapView />
    </section>
  </div>
</template>

<script setup lang="ts">
import AppSidebar from "@/components/layout/AppSidebar.vue";
import MapView from "@/components/map/MapView.vue";
</script>

<style scoped>
div {
  height: 100%;
}
</style>

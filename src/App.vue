<template>
  <div class="flex flex-col min-h-screen">
    <!-- Basic header / nav placeholder -->
    <header class="p-4 bg-primary-600 text-white">
      <!-- <h1 class="text-xl font-bold">RichiRoute - Bicycle Planner</h1> -->
    </header>

    <!-- Main content area -->
    <main class="flex-grow">
      <MapView />
      <Icon name="undo" :svgClass="'w-8 h-8 text-white'" />
    </main>

    <!-- <footer class="p-4 bg-primary-800 text-white text-center">
      © {{ new Date().getFullYear() }} RichiRoute
    </footer> -->
  </div>
</template>

<script setup lang="ts">
import MapView from "@/components/map/MapView.vue";
import Icon from "@/components/ui/Icon.vue";
</script>

<style scoped>
/* Scoped styles for the App shell (optional) */
</style>

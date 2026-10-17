<!-- src/App.vue -->
<template>
  <Toast />
  <DebugControls />
  <router-view />
</template>

<script setup lang="ts">
import Toast from 'primevue/toast';
import DebugControls from '@/components/debug/DebugControls.vue';
// Root shell
</script>

<style>
#app,
body {
  margin: 0;
  height: 100vh;
  width: 100vw;
}
</style>

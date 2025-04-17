<!-- src/App.vue -->
<template>
  <Toast />
  <router-view />
</template>

<script setup lang="ts">
import Toast from "primevue/toast";
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

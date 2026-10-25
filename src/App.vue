<template><v-app><HomeView /></v-app></template>
<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import HomeView from './views/HomeView.vue';
import { useRouteStore } from './stores/route.store';
import { startDraftPersistence } from './services/draft.service';

onBeforeUnmount(startDraftPersistence(useRouteStore()));
</script>

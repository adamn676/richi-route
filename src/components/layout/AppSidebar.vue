<template>
  <aside class="sidebar">
    <header class="sidebar__header">
      <h1>RichiRoute</h1>
      <span v-if="!routeStore.draftError" class="sidebar__status" aria-live="polite" title="Die aktuelle Route wird in diesem Browser gespeichert.">
        <IconCloudCheck v-if="routeStore.draftStatus === 'saved' || routeStore.draftStatus === 'restored'" :size="16" aria-hidden="true" />{{ draftLabel }}
      </span>
      <button v-if="hasDraft" type="button" class="btn btn--sm sidebar__new" @click="library.newRoute()">
        <IconPlus :size="16" aria-hidden="true" />Neue Route
      </button>
    </header>
    <div class="sidebar__tabs" role="tablist" aria-label="Bereiche" @keydown="moveFocus">
      <button v-for="item in tabs" :id="`tab-${item.id}`" :key="item.id" type="button" role="tab"
        :aria-selected="tab === item.id" :aria-controls="`panel-${item.id}`" :tabindex="tab === item.id ? 0 : -1"
        @click="tab = item.id">{{ item.label }}</button>
    </div>
    <!-- Saving a draft before a route switch can report from any tab. -->
    <div class="sidebar__messages">
      <p v-if="routeStore.draftError" class="notice notice--error" role="alert">
        {{ routeStore.draftError }}
        <button type="button" class="btn" @click="saveDraftNow(routeStore)">Aktuelle Route hier speichern</button>
      </p>
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
      <p v-else-if="message" class="notice notice--success" role="status">{{ message }}</p>
    </div>
    <div class="sidebar__body">
      <RoutePanel v-show="tab === 'route'" id="panel-route" role="tabpanel" aria-labelledby="tab-route"
        @new-route="(coords, shapeIndices) => library.newRoute(coords, shapeIndices)" />
      <SavedRoutes v-show="tab === 'library'" id="panel-library" :library="library" role="tabpanel" aria-labelledby="tab-library" />
      <GpxImport v-show="tab === 'gpx'" id="panel-gpx" role="tabpanel" aria-labelledby="tab-gpx" />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { IconCloudCheck, IconPlus } from '@/components/icons';
import RoutePanel from '@/components/ui/RoutePanel.vue';
import SavedRoutes from '@/components/ui/SavedRoutes.vue';
import GpxImport from '@/components/ui/GpxImport.vue';
import { useRouteLibrary } from '@/composables/useRouteLibrary';
import { useRouteStore } from '@/stores/route.store';
import { saveDraftNow } from '@/services/draft.service';

const routeStore = useRouteStore();
const library = useRouteLibrary();
const { hasDraft, error, message } = library;
const tabs = [{ id: 'route', label: 'Route' }, { id: 'library', label: 'Meine Routen' }, { id: 'gpx', label: 'GPX' }] as const;
const tab = ref<typeof tabs[number]['id']>('route');
const draftLabel = computed(() => ({
  idle: 'Speichert automatisch',
  saving: 'Wird gespeichert …',
  saved: 'Gespeichert',
  restored: 'Wiederhergestellt',
  error: '',
}[routeStore.draftStatus]));

async function moveFocus(event: KeyboardEvent) {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  const index = tabs.findIndex(item => item.id === tab.value);
  tab.value = tabs[(index + step + tabs.length) % tabs.length].id;
  await nextTick();
  document.getElementById(`tab-${tab.value}`)?.focus();
}
</script>

<style scoped>
.sidebar { display: flex; flex-direction: column; background: var(--surface); }
.sidebar__header { display: flex; align-items: center; gap: .75rem; min-height: 3.5rem; padding: .6rem var(--gutter) .4rem; }
h1 { margin: 0; font-size: 1.15rem; font-weight: 750; letter-spacing: -.02em; }
.sidebar__status { display: inline-flex; align-items: center; gap: .3rem; color: var(--text-muted); font-size: .78rem; }
.sidebar__new { margin-left: auto; }
.sidebar__tabs { display: flex; gap: 1.25rem; padding: 0 var(--gutter); border-bottom: 1px solid var(--border); }
[role=tab] { padding: .7rem 0; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; background: none;
  color: var(--text-muted); font-size: .88rem; font-weight: 600; }
[role=tab]:hover { color: var(--text); }
[role=tab][aria-selected=true] { border-bottom-color: var(--accent); color: var(--text); }
.sidebar__messages { display: grid; gap: .5rem; max-height: 40%; overflow-y: auto; padding-inline: var(--gutter); }
.sidebar__messages:not(:empty) { padding-block: .75rem; }
.sidebar__body { flex: 1; min-height: 0; overflow-y: auto; scroll-padding-bottom: 5rem; }
</style>

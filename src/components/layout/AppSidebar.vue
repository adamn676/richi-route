<template>
  <aside class="sidebar">
    <header class="sidebar__header">
      <h1 class="brand"><span class="brand__mark" aria-hidden="true"><IconRoute :size="18" /></span><span>Richi<span class="brand__accent">Route</span></span></h1>
      <!-- Errors have their own notice below; otherwise the icon's shape shows the state and the tooltip explains it. -->
      <span v-if="!routeStore.draftError" class="sidebar__status" role="img" :aria-label="draft.label" :title="draft.label">
        <component :is="draft.icon" :size="18" aria-hidden="true" />
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
    <!-- Only the OpenStreetMap credit stays in view; MapView places the full list of sources here (useMap's credits container). -->
    <details class="sidebar__credits">
      <summary>© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> · <span>Quellen</span></summary>
      <div id="map-credits" />
    </details>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { IconCloud, IconCloudCheck, IconCloudUpload, IconPlus, IconRoute } from '@/components/icons';
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
const draft = computed(() => ({
  idle: { icon: IconCloud, label: 'Die aktuelle Route wird automatisch in diesem Browser gespeichert' },
  saving: { icon: IconCloudUpload, label: 'Wird gespeichert …' },
  saved: { icon: IconCloudCheck, label: 'In diesem Browser gespeichert' },
  restored: { icon: IconCloudCheck, label: 'Aus diesem Browser wiederhergestellt' },
  error: { icon: IconCloud, label: '' },
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
.brand { display: flex; align-items: center; gap: .5rem; margin: 0; font-size: 1.1rem; font-weight: 750; letter-spacing: -.02em; white-space: nowrap; }
.brand__mark { display: grid; place-items: center; width: 1.9rem; height: 1.9rem; border-radius: var(--radius); background: var(--accent); color: #fff; }
.brand__mark svg { stroke-width: 2.25; }
.brand__accent { color: var(--accent); }
.sidebar__status { display: inline-flex; color: var(--text-muted); cursor: help; }
.sidebar__new { margin-left: auto; }
.sidebar__tabs { display: flex; gap: 1.25rem; padding: 0 var(--gutter); border-bottom: 1px solid var(--border); }
[role=tab] { padding: .7rem 0; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; background: none;
  color: var(--text-muted); font-size: .88rem; font-weight: 600; }
[role=tab]:hover { color: var(--text); }
[role=tab][aria-selected=true] { border-bottom-color: var(--accent); color: var(--text); }
.sidebar__messages { display: grid; gap: .5rem; max-height: 40%; overflow-y: auto; padding-inline: var(--gutter); }
.sidebar__messages:not(:empty) { padding-block: .75rem; }
.sidebar__body { flex: 1; min-height: 0; overflow-y: auto; }
.sidebar__credits { padding: .35rem var(--gutter); border-top: 1px solid var(--border); color: var(--text-muted); font-size: .68rem; line-height: 1.4; }
.sidebar__credits summary { list-style: none; cursor: pointer; }
.sidebar__credits summary::-webkit-details-marker { display: none; }
.sidebar__credits summary span { text-decoration: underline; }
.sidebar__credits[open] summary { margin-bottom: .25rem; }
.sidebar__credits :deep(.maplibregl-ctrl-attrib) { margin: 0; padding: 0; background: none; }
.sidebar__credits :deep(a) { color: inherit; }
</style>

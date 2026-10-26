<template>
  <aside class="sidebar">
    <header class="sidebar__header">
      <h1 class="brand"><span class="brand__mark" aria-hidden="true"><IconRoute :size="18" /></span><span>Richi<span class="brand__accent">Route</span></span></h1>
      <!-- Errors have their own notice below; otherwise the icon's shape shows the state and the tooltip explains it. -->
      <span v-if="!routeStore.draftError" class="sidebar__status" role="img" :aria-label="draft.label" v-tooltip:bottom="draft.label">
        <component :is="draft.icon" :size="18" aria-hidden="true" />
      </span>
      <v-btn v-if="hasDraft" class="sidebar__new" variant="outlined" size="small" :prepend-icon="IconPlus" @click="newRoute">Neue Route</v-btn>
    </header>
    <v-tabs v-model="tab" class="sidebar__tabs" aria-label="Bereiche">
      <v-tab v-for="item in tabs" :id="`tab-${item.id}`" :key="item.id" :value="item.id" :aria-controls="`panel-${item.id}`"
        @click="emit('tab-click')">{{ item.label }}</v-tab>
    </v-tabs>
    <!-- Saving a draft before a route switch can report from any tab. -->
    <div class="sidebar__messages">
      <v-alert v-if="routeStore.draftError" type="error">
        {{ routeStore.draftError }}
        <template #append><v-btn variant="text" size="small" @click="saveDraftNow(routeStore)">Aktuelle Route hier speichern</v-btn></template>
      </v-alert>
      <v-alert v-if="error" type="error">{{ error }}</v-alert>
    </div>
    <!-- Confirmations pass by; errors stay above until resolved. -->
    <v-snackbar :key="message" :model-value="Boolean(message) && !error" :timeout="4000" @update:model-value="open => open || (message = '')">{{ message }}</v-snackbar>
    <div class="sidebar__body">
      <RoutePanel v-show="tab === 'route'" id="panel-route" role="tabpanel" aria-labelledby="tab-route" />
      <SavedRoutes v-show="tab === 'library'" id="panel-library" :library="library" role="tabpanel" aria-labelledby="tab-library" />
      <GpxImport v-show="tab === 'gpx'" id="panel-gpx" role="tabpanel" aria-labelledby="tab-gpx" @open-route="openTrack" />
    </div>
    <!-- Only the OpenStreetMap credit stays in view; MapView places the full list of sources here (useMap's credits container)
         and opens it while an online map or overlay shows. -->
    <details class="sidebar__credits">
      <summary>© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> · <span>Quellen</span></summary>
      <div id="map-credits" />
    </details>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useDisplay } from 'vuetify';
import { IconCloud, IconCloudCheck, IconCloudUpload, IconPlus, IconRoute } from '@/components/icons';
import RoutePanel from '@/components/ui/RoutePanel.vue';
import SavedRoutes from '@/components/ui/SavedRoutes.vue';
import GpxImport from '@/components/ui/GpxImport.vue';
import { useRouteLibrary } from '@/composables/useRouteLibrary';
import { useRouteStore } from '@/stores/route.store';
import { useGpxReferenceStore } from '@/stores/gpx-reference.store';
import { saveDraftNow } from '@/services/draft.service';

// A tab chosen on the folded phone sheet raises it (HomeView).
const emit = defineEmits<{ 'tab-click': [] }>();
const routeStore = useRouteStore();
const library = useRouteLibrary();
const { hasDraft, error, message } = library;
const tabs = [{ id: 'route', label: 'Route' }, { id: 'library', label: 'Meine Routen' }, { id: 'gpx', label: 'GPX' }] as const;
const tab = ref<typeof tabs[number]['id']>('route');
// An imported track opened as the route no longer needs its comparison line.
const reference = useGpxReferenceStore();
async function openTrack() {
  if (!reference.track) return;
  await library.openTrack(reference.track);
  if (error.value) return;
  reference.remove();
  await showRoute();
}
// A new route starts in its Start field, except on phones, where the keyboard would cover the map.
const { mobile } = useDisplay();
async function newRoute() {
  await library.newRoute();
  if (error.value) return;
  await showRoute(mobile.value ? undefined : `address-${routeStore.waypoints[0].id}`);
}
// The button that led here is gone, so the focus moves to the route.
async function showRoute(focus = 'tab-route') {
  tab.value = 'route';
  await nextTick();
  if (document.activeElement === document.body) document.getElementById(focus)?.focus();
}
const draft = computed(() => ({
  idle: { icon: IconCloud, label: 'Die aktuelle Route wird automatisch in diesem Browser gespeichert' },
  saving: { icon: IconCloudUpload, label: 'Wird gespeichert …' },
  saved: { icon: IconCloudCheck, label: 'In diesem Browser gespeichert' },
  restored: { icon: IconCloudCheck, label: 'Aus diesem Browser wiederhergestellt' },
  error: { icon: IconCloud, label: '' },
}[routeStore.draftStatus]));

</script>

<style scoped>
.sidebar { display: flex; flex-direction: column; background: var(--surface); }
.sidebar__header { display: flex; align-items: center; gap: .75rem; min-height: 3.5rem; padding: .6rem var(--gutter) .4rem; }
/* On phones the sheet's handle above gives the space. */
@media (max-width: 760px) { .sidebar__header { min-height: 3rem; padding-top: 0; } }
.brand { display: flex; align-items: center; gap: .5rem; margin: 0; font-size: 1.1rem; font-weight: 750; letter-spacing: -.02em; white-space: nowrap; }
.brand__mark { display: grid; place-items: center; width: 1.9rem; height: 1.9rem; border-radius: var(--radius); background: var(--accent); color: #fff; }
.brand__mark svg { stroke-width: 2.25; }
.brand__accent { color: var(--accent); }
.sidebar__status { display: inline-flex; color: var(--text-muted); cursor: help; }
.sidebar__new { margin-left: auto; }
.sidebar__tabs { flex: none; border-bottom: 1px solid var(--border); }
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

<template>
  <section class="gpx" @dragover.prevent @drop.prevent="dropFile">
    <input ref="fileInput" type="file" accept=".gpx,application/gpx+xml,application/xml,text/xml" aria-label="GPX-Datei auswählen" hidden @change="importSelected" />
    <p v-if="reference.loading" class="gpx__loading" role="status">GPX wird eingelesen … <v-btn variant="text" size="small" @click="reference.cancel()">Abbrechen</v-btn></p>
    <v-alert v-if="reference.error" class="gpx__error" type="error">{{ reference.error }}</v-alert>
    <template v-if="track">
      <div class="gpx__track">
        <div class="gpx__title">
          <h3>{{ track.name }}</h3>
          <span class="gpx__file text-body-small text-medium-emphasis">{{ track.fileName }}<template v-if="track.segments.length > 1"> · {{ track.segments.length }} Abschnitte</template></span>
        </div>
        <div class="gpx__tools">
          <v-icon-button v-tooltip:bottom="reference.visible ? 'Track ausblenden' : 'Track einblenden'" role="switch"
            :aria-checked="reference.visible" aria-label="Track einblenden" @click="reference.visible = !reference.visible">
            <component :is="reference.visible ? IconEye : IconEyeOff" :size="18" aria-hidden="true" /></v-icon-button>
          <v-icon-button v-tooltip:bottom="'Track zeigen'" aria-label="Track zeigen" @click="reference.show()"><IconFocus2 :size="18" aria-hidden="true" /></v-icon-button>
          <v-icon-button v-tooltip:bottom="'Andere GPX-Datei öffnen'" :disabled="reference.loading" aria-label="Andere GPX-Datei öffnen"
            @click="fileInput?.click()"><IconFileImport :size="18" aria-hidden="true" /></v-icon-button>
          <v-icon-button v-tooltip:bottom="'Track entfernen'" aria-label="Track entfernen" @click="reference.remove()"><IconTrash :size="18" aria-hidden="true" /></v-icon-button>
        </div>
      </div>
      <dl class="stats">
        <div><dt>Distanz</dt><dd>{{ formatKm(track.distanceMeters) }} km</dd></div>
        <div><dt>Anstiege</dt><dd>{{ track.ascentMeters === null ? 'unbekannt' : formatMeters(track.ascentMeters) }}</dd></div>
      </dl>
      <v-btn v-tooltip:bottom="'Ersetzt die aktuelle Route; diese bleibt in „Meine Routen“'" variant="flat" block
        :prepend-icon="IconRoute" @click="emit('open-route')">Als Route öffnen</v-btn>
      <!-- Material segmented buttons: four short choices are one tap away. -->
      <v-btn-toggle v-model="reference.colorMode" class="gpx__color" role="group" aria-label="Trackfarbe" mandatory divided
        variant="outlined" color="primary" density="compact" rounded="xl">
        <v-btn v-for="mode in colorModes" :key="mode.value" :value="mode.value" :data-mode="mode.value" :aria-pressed="reference.colorMode === mode.value"
          :disabled="mode.needsHeights && !track.elevationCount">{{ mode.label }}</v-btn>
      </v-btn-toggle>
      <ul v-if="reference.colorMode !== 'plain'" class="legend" aria-label="Legende der Trackfarben">
        <li v-for="item in legend" :key="item.label"><i class="swatch" :style="{ backgroundColor: item.color }" />{{ item.label }}</li>
        <li v-if="reference.colorMode !== 'surface'"><i class="swatch" :style="{ backgroundColor: unknownGpxColor }" />Unbekannt</li>
      </ul>
      <div v-if="reference.colorMode === 'surface'" class="gpx__surfaces">
        <p v-if="reference.surfaceLoading" class="text-body-small text-medium-emphasis" role="status">Beläge werden geprüft … {{ reference.surfaceProgress.total ? Math.round(reference.surfaceProgress.completed / reference.surfaceProgress.total * 100) : 0 }} %
          <v-btn variant="text" size="small" @click="reference.cancelSurfaces()">Belagprüfung abbrechen</v-btn>
        </p>
        <v-alert v-if="reference.surfaceError" type="error">{{ reference.surfaceError }} Noch nicht geprüfte Teile bleiben unbekannt.</v-alert>
        <v-btn v-if="!reference.surfaceLoading && (!reference.surfaces || reference.surfaceError)" variant="outlined" size="small" class="gpx__start"
          @click="reference.loadSurfaces()">Beläge ermitteln</v-btn>
        <template v-if="reference.surfaces && reference.surfaceInspection">
          <p class="text-body-small text-medium-emphasis">{{ formatKm(reference.surfaceInspection.estimatedMeters) }} von {{ formatKm(track.distanceMeters) }} km mit zugeordnetem Belag.</p>
          <ul aria-label="Beläge des GPX-Tracks">
            <li v-for="item in reference.surfaceInspection.totals" :key="item.key"><span><i class="swatch" :style="{ backgroundColor: item.color }" />{{ item.label }}</span><span>{{ formatKm(item.meters) }} km · {{ track.distanceMeters ? Math.round(item.meters / track.distanceMeters * 100) : 0 }} %</span></li>
          </ul>
        </template>
      </div>
      <GpxElevationProfile :track="track" />
    </template>
    <div v-else-if="!reference.loading" class="gpx__empty">
      <IconFileImport :size="28" aria-hidden="true" />
      <v-btn variant="flat" @click="fileInput?.click()">GPX-Datei öffnen</v-btn>
      <span class="text-body-small text-medium-emphasis">oder hierher ziehen</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { IconEye, IconEyeOff, IconFileImport, IconFocus2, IconRoute, IconTrash } from '@/components/icons';
import { useGpxReferenceStore } from '../../stores/gpx-reference.store';
import { elevationColors, gradientBands, unknownGpxColor } from '../../domain/gpx-inspection';
import GpxElevationProfile from './GpxElevationProfile.vue';
import { formatKm, formatMeters } from '@/utils/format';
import { surfaceLegend } from '../../domain/gpx-surfaces';

const emit = defineEmits<{ 'open-route': [] }>();
const reference = useGpxReferenceStore();
const { track } = storeToRefs(reference);
const fileInput = ref<HTMLInputElement>();
const colorModes = [
  { value: 'plain', label: 'Einfarbig', needsHeights: false }, { value: 'elevation', label: 'Höhe', needsHeights: true },
  { value: 'gradient', label: 'Steigung', needsHeights: true }, { value: 'surface', label: 'Belag', needsHeights: false },
] as const;
const legend = computed(() => {
  if (reference.colorMode === 'surface') return surfaceLegend;
  if (reference.colorMode === 'gradient') return gradientBands;
  const profile = track.value?.profile;
  if (!profile) return [];
  if (profile.minimum === profile.maximum) return [{ color: elevationColors[2], label: `${Math.round(profile.minimum)} m` }];
  return elevationColors.map((color, i) => {
    const from = profile.minimum + (profile.maximum - profile.minimum) * i / elevationColors.length;
    const to = profile.minimum + (profile.maximum - profile.minimum) * (i + 1) / elevationColors.length;
    return { color, label: `${Math.round(from)} bis ${Math.round(to)} m` };
  });
});
function dropFile(event: DragEvent) {
  const file = event.dataTransfer?.files[0];
  if (file) void reference.importFile(file);
}
async function importSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) await reference.importFile(file);
  input.value = '';
}
</script>

<style scoped>
.gpx { display: grid; gap: .85rem; min-height: 100%; align-content: start; padding: 1rem var(--gutter) 1.5rem; }
.gpx__track { display: flex; align-items: flex-start; gap: .5rem; }
.gpx__title { display: grid; flex: 1; min-width: 0; gap: .15rem; }
.gpx__file { overflow-wrap: anywhere; }
h3 { margin: 0; font-size: 1.05rem; font-weight: 650; overflow-wrap: anywhere; }
.gpx__tools { display: flex; flex-shrink: 0; }
.gpx__loading { display: flex; align-items: center; justify-content: space-between; margin: 0; font-size: .82rem; }
.gpx__color { width: 100%; }
.gpx__color .v-btn { flex: 1; }
.gpx__surfaces { display: grid; gap: .5rem; }
.gpx__start { justify-self: start; }
.gpx__surfaces ul { display: grid; gap: .3rem; margin: 0; padding: 0; list-style: none; font-size: .8rem; }
.gpx__surfaces li { display: flex; justify-content: space-between; gap: .5rem; font-variant-numeric: tabular-nums; }
.gpx__surfaces li span:first-child { display: inline-flex; align-items: center; gap: .4rem; }
.gpx__empty { display: grid; justify-items: center; gap: .6rem; padding: 1.75rem 1.25rem; border: 1.5px dashed var(--border-input);
  border-radius: var(--radius-lg); color: var(--text-muted); text-align: center; }
</style>

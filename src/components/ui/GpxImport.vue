<template>
  <section class="gpx" @dragover.prevent @drop.prevent="dropFile">
    <input ref="fileInput" type="file" accept=".gpx,application/gpx+xml,application/xml,text/xml" aria-label="GPX-Datei auswählen" hidden @change="importSelected" />
    <p v-if="reference.loading" class="gpx__loading" role="status">GPX wird eingelesen … <button type="button" class="btn btn--ghost" @click="reference.cancel()">Abbrechen</button></p>
    <p v-if="reference.error" class="notice notice--error gpx__error" role="alert">{{ reference.error }}</p>
    <template v-if="track">
      <div class="gpx__track">
        <div class="gpx__title">
          <h3>{{ track.name }}</h3>
          <span class="muted">{{ track.fileName }} · {{ track.pointCount.toLocaleString('de-DE') }} Punkte<template v-if="track.segments.length > 1"> · {{ track.segments.length }} Abschnitte</template></span>
        </div>
        <div class="gpx__tools">
          <!-- The checkbox lies invisibly over the eye icon. -->
          <label class="btn btn--ghost btn--icon gpx__toggle" :title="reference.visible ? 'Track ausblenden' : 'Track einblenden'">
            <input v-model="reference.visible" type="checkbox" aria-label="Track einblenden" />
            <component :is="reference.visible ? IconEye : IconEyeOff" :size="18" aria-hidden="true" />
          </label>
          <button type="button" class="btn btn--ghost btn--icon" aria-label="Track zeigen" title="Track zeigen" @click="reference.show()"><IconFocus2 :size="18" aria-hidden="true" /></button>
          <button type="button" class="btn btn--ghost btn--icon" :disabled="reference.loading" aria-label="Andere GPX-Datei öffnen" title="Andere GPX-Datei öffnen" @click="fileInput?.click()"><IconFileImport :size="18" aria-hidden="true" /></button>
          <button type="button" class="btn btn--ghost btn--icon" aria-label="Track entfernen" title="Track entfernen" @click="reference.remove()"><IconTrash :size="18" aria-hidden="true" /></button>
        </div>
      </div>
      <dl class="stats">
        <div><dt>Distanz</dt><dd>{{ (track.distanceMeters / 1000).toLocaleString('de-DE', { maximumFractionDigits: 2 }) }} km</dd></div>
        <div><dt>Anstiege</dt><dd>{{ track.ascentMeters === null ? 'unbekannt' : `${Math.round(track.ascentMeters).toLocaleString('de-DE')} m` }}</dd></div>
      </dl>
      <label class="gpx__color"><span class="label">Trackfarbe</span>
        <select v-model="reference.colorMode" class="field" aria-label="Trackfarbe">
          <option value="plain">Einfarbig</option>
          <option value="elevation" :disabled="!track.elevationCount">Höhe</option>
          <option value="gradient" :disabled="!track.elevationCount">Steigung</option>
          <option value="surface">Belag (geschätzt)</option>
        </select>
      </label>
      <ul v-if="reference.colorMode !== 'plain'" class="legend" aria-label="Legende der Trackfarben">
        <li v-for="item in legend" :key="item.label"><i class="swatch" :style="{ backgroundColor: item.color }" />{{ item.label }}</li>
        <li v-if="reference.colorMode !== 'surface'"><i class="swatch" :style="{ backgroundColor: unknownGpxColor }" />Unbekannt</li>
      </ul>
      <div v-if="reference.colorMode === 'surface'" class="gpx__surfaces">
        <p class="muted">Schätzung aus lokalen OSM-Daten. Eng benachbarte Wege können verwechselt werden.</p>
        <p v-if="reference.surfaceLoading" class="muted" role="status">Beläge werden geprüft: {{ reference.surfaceProgress.completed }} / {{ reference.surfaceProgress.total }} Teilstrecken
          <button type="button" class="btn btn--ghost" @click="reference.cancelSurfaces()">Belagprüfung abbrechen</button>
        </p>
        <p v-if="reference.surfaceError" class="notice notice--error gpx__error" role="alert">{{ reference.surfaceError }} Noch nicht geprüfte Teile bleiben unbekannt.</p>
        <button v-if="!reference.surfaceLoading && (!reference.surfaces || reference.surfaceError)" type="button" class="btn" @click="reference.loadSurfaces()">Beläge ermitteln</button>
        <template v-if="reference.surfaces && reference.surfaceInspection">
          <p class="muted">{{ (reference.surfaceInspection.estimatedMeters / 1000).toLocaleString('de-DE', { maximumFractionDigits: 2 }) }} von {{ (track.distanceMeters / 1000).toLocaleString('de-DE', { maximumFractionDigits: 2 }) }} km mit zugeordnetem Belag.</p>
          <ul aria-label="Beläge des GPX-Tracks">
            <li v-for="item in reference.surfaceInspection.totals" :key="item.key"><span><i class="swatch" :style="{ backgroundColor: item.color }" />{{ item.label }}</span><span>{{ (item.meters / 1000).toLocaleString('de-DE', { maximumFractionDigits: 2 }) }} km · {{ track.distanceMeters ? Math.round(item.meters / track.distanceMeters * 100) : 0 }} %</span></li>
          </ul>
        </template>
      </div>
      <GpxElevationProfile :track="track" />
      <p v-if="track.elevationCount < track.pointCount" class="muted">Höhe für {{ track.elevationCount.toLocaleString('de-DE') }} von {{ track.pointCount.toLocaleString('de-DE') }} Punkten vorhanden; Lücken bleiben im Profil offen.</p>
    </template>
    <div v-else-if="!reference.loading" class="gpx__empty">
      <IconFileImport :size="28" aria-hidden="true" />
      <p><strong>Aufgezeichneten Track vergleichen</strong>Zeigt eine GPX-Datei neben deiner Route. Die Datei bleibt auf diesem Gerät.</p>
      <button type="button" class="btn btn--primary" @click="fileInput?.click()">GPX-Datei öffnen</button>
      <span class="muted">oder hierher ziehen</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { IconEye, IconEyeOff, IconFileImport, IconFocus2, IconTrash } from '@/components/icons';
import { useGpxReferenceStore } from '../../stores/gpx-reference.store';
import { elevationColors, gradientBands, unknownGpxColor } from '../../domain/gpx-inspection';
import GpxElevationProfile from './GpxElevationProfile.vue';
import { surfaceLegend } from '../../domain/gpx-surfaces';

const reference = useGpxReferenceStore();
const { track } = storeToRefs(reference);
const fileInput = ref<HTMLInputElement>();
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
.gpx__title .muted { font-size: .75rem; overflow-wrap: anywhere; }
h3 { margin: 0; font-size: 1.05rem; font-weight: 650; overflow-wrap: anywhere; }
.gpx__tools { display: flex; flex-shrink: 0; }
.gpx__toggle { position: relative; cursor: pointer; }
.gpx__toggle input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; }
.gpx__toggle:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.gpx__loading { display: flex; align-items: center; justify-content: space-between; margin: 0; font-size: .82rem; }
.gpx__color { display: grid; grid-template-columns: auto minmax(0, 12rem); align-items: center; justify-content: space-between; gap: .75rem; }
.gpx__surfaces { display: grid; gap: .5rem; }
.gpx__surfaces .btn { justify-self: start; }
.gpx__surfaces ul { display: grid; gap: .3rem; margin: 0; padding: 0; list-style: none; font-size: .8rem; }
.gpx__surfaces li { display: flex; justify-content: space-between; gap: .5rem; font-variant-numeric: tabular-nums; }
.gpx__surfaces li span:first-child { display: inline-flex; align-items: center; gap: .4rem; }
.gpx__empty { display: grid; justify-items: center; gap: .6rem; padding: 1.75rem 1.25rem; border: 1.5px dashed var(--border-input);
  border-radius: var(--radius-lg); color: var(--text-muted); text-align: center; }
.gpx__empty p { margin: 0; font-size: .82rem; line-height: 1.5; }
.gpx__empty strong { display: block; margin-bottom: .2rem; color: var(--text); font-size: .9rem; }
</style>

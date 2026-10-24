<template>
  <section class="gpx">
    <div class="gpx__heading">
      <h2 class="section-title">GPX-Referenz</h2>
      <button type="button" class="btn" :class="{ 'btn--primary': !track }" :disabled="reference.loading" @click="fileInput?.click()">
        <IconFileImport :size="16" aria-hidden="true" />GPX importieren
      </button>
      <input ref="fileInput" type="file" accept=".gpx,application/gpx+xml,application/xml,text/xml" aria-label="GPX-Datei auswählen" @change="importSelected" />
    </div>
    <p v-if="reference.loading" class="gpx__loading" role="status">GPX wird eingelesen … <button type="button" class="btn btn--ghost" @click="reference.cancel()">Abbrechen</button></p>
    <p v-if="reference.error" class="notice notice--error gpx__error" role="alert">{{ reference.error }}</p>
    <template v-if="track">
      <h3>{{ track.name }}</h3>
      <dl class="stats">
        <div><dt>Trackdistanz</dt><dd>{{ (track.distanceMeters / 1000).toLocaleString('de-AT', { maximumFractionDigits: 2 }) }} km</dd></div>
        <div><dt>Aufstieg aus GPX</dt><dd>{{ track.ascentMeters === null ? 'Unvollständige Höhendaten' : `${Math.round(track.ascentMeters)} m` }}</dd></div>
      </dl>
      <div class="gpx__actions">
        <label class="gpx__toggle"><input v-model="reference.visible" type="checkbox" /> Track einblenden</label>
        <button type="button" class="btn" aria-label="Track zeigen" @click="reference.show()"><IconFocus2 :size="16" aria-hidden="true" />Zeigen</button>
        <button type="button" class="btn btn--ghost btn--icon" title="Track entfernen" @click="reference.remove()"><IconTrash :size="18" aria-hidden="true" /></button>
      </div>
      <label class="gpx__color">Trackfarbe
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
          <p class="muted">{{ (reference.surfaceInspection.estimatedMeters / 1000).toLocaleString('de-AT', { maximumFractionDigits: 2 }) }} von {{ (track.distanceMeters / 1000).toLocaleString('de-AT', { maximumFractionDigits: 2 }) }} km mit zugeordnetem Belag.</p>
          <ul aria-label="Beläge des GPX-Tracks">
            <li v-for="item in reference.surfaceInspection.totals" :key="item.key"><span><i class="swatch" :style="{ backgroundColor: item.color }" />{{ item.label }}</span><span>{{ (item.meters / 1000).toLocaleString('de-AT', { maximumFractionDigits: 2 }) }} km · {{ track.distanceMeters ? Math.round(item.meters / track.distanceMeters * 100) : 0 }} %</span></li>
          </ul>
        </template>
      </div>
      <GpxElevationProfile :track="track" />
      <details class="disclosure">
        <summary>Trackdetails und Hinweise</summary>
        <p>{{ track.fileName }}<br />{{ track.pointCount.toLocaleString('de-AT') }} Punkte · {{ track.segments.length }} {{ track.segments.length === 1 ? 'Abschnitt' : 'Abschnitte' }}</p>
        <p v-if="track.elevationCount < track.pointCount">Höhe für {{ track.elevationCount.toLocaleString('de-AT') }} von {{ track.pointCount.toLocaleString('de-AT') }} Punkten vorhanden. Fehlende Werte und Abschnittswechsel bleiben im Profil getrennt.</p>
        <p v-if="reference.colorMode === 'gradient'">Steigung aus GPX-Höhen, über etwa 50 m geglättet. Bei weit auseinanderliegenden Punkten über eine längere Strecke.</p>
        <p>S = Start, Z = Ziel je Abschnitt. S/Z kennzeichnet eine geschlossene Runde; die Pfeile zeigen die Laufrichtung.</p>
        <p>Originaltrack als Referenz für diese Sitzung. Deine geplante Route bleibt erhalten. Nach dem Neuladen die GPX-Datei erneut importieren.</p>
      </details>
    </template>
    <p v-else-if="!reference.loading" class="muted">Öffne eine GPX-Datei, um einen aufgezeichneten Track als Referenz neben deiner Route auf der Karte zu prüfen. Die Datei bleibt auf diesem Gerät.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { IconFileImport, IconFocus2, IconTrash } from '@/components/icons';
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
async function importSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) await reference.importFile(file);
  input.value = '';
}
</script>

<style scoped>
.gpx { display: grid; gap: .85rem; padding: 1rem var(--gutter) 1.5rem; }
.gpx__heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
h3 { margin: .25rem 0 0; font-size: 1.05rem; font-weight: 650; overflow-wrap: anywhere; }
input[type=file] { display: none; }
.gpx__loading { display: flex; align-items: center; justify-content: space-between; margin: 0; font-size: .82rem; }
.gpx__actions { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
.gpx__toggle { display: inline-flex; align-items: center; gap: .4rem; min-height: 2.25rem; margin-right: auto; font-size: .85rem; }
.gpx__color { display: grid; grid-template-columns: auto minmax(0, 12rem); align-items: center; justify-content: space-between; gap: .75rem; font-size: .85rem; }
.gpx__surfaces { display: grid; gap: .5rem; }
.gpx__surfaces .btn { justify-self: start; }
.gpx__surfaces ul { display: grid; gap: .3rem; margin: 0; padding: 0; list-style: none; font-size: .8rem; }
.gpx__surfaces li { display: flex; justify-content: space-between; gap: .5rem; font-variant-numeric: tabular-nums; }
.gpx__surfaces li span:first-child { display: inline-flex; align-items: center; gap: .4rem; }
</style>

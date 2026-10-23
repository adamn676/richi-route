<template>
  <section class="gpx" aria-label="GPX-Referenz">
    <div class="gpx__heading">
      <h2>GPX-Referenz</h2>
      <button type="button" :disabled="reference.loading" @click="fileInput?.click()">GPX importieren</button>
      <input ref="fileInput" type="file" accept=".gpx,application/gpx+xml,application/xml,text/xml" aria-label="GPX-Datei auswählen" @change="importSelected" />
    </div>
    <p v-if="reference.loading" role="status">GPX wird eingelesen … <button type="button" @click="reference.cancel()">Abbrechen</button></p>
    <p v-if="reference.error" class="gpx__error" role="alert">{{ reference.error }}</p>
    <template v-if="track">
      <h3>{{ track.name }}</h3>
      <p class="gpx__file">{{ track.fileName }}</p>
      <dl>
        <div><dt>Trackdistanz</dt><dd>{{ (track.distanceMeters / 1000).toLocaleString('de-AT', { maximumFractionDigits: 2 }) }} km</dd></div>
        <div><dt>Aufstieg aus GPX</dt><dd>{{ track.ascentMeters === null ? 'Unvollständige Höhendaten' : `${Math.round(track.ascentMeters)} m` }}</dd></div>
      </dl>
      <p>{{ track.pointCount.toLocaleString('de-AT') }} Punkte · {{ track.segments.length }} {{ track.segments.length === 1 ? 'Abschnitt' : 'Abschnitte' }}</p>
      <label class="gpx__color">Trackfarbe
        <select v-model="reference.colorMode" aria-label="Trackfarbe">
          <option value="plain">Einfarbig</option>
          <option value="elevation" :disabled="!track.elevationCount">Höhe</option>
          <option value="gradient" :disabled="!track.elevationCount">Steigung</option>
        </select>
      </label>
      <div v-if="reference.colorMode !== 'plain'" class="gpx__legend" aria-label="Legende der Trackfarben">
        <span v-for="item in legend" :key="item.label"><i :style="{ backgroundColor: item.color }" />{{ item.label }}</span>
        <span><i :style="{ backgroundColor: unknownGpxColor }" />Unbekannt</span>
      </div>
      <p v-if="reference.colorMode === 'gradient'">Steigung aus GPX-Höhen, über etwa 50 m geglättet. Bei weit auseinanderliegenden Punkten über eine längere Strecke.</p>
      <GpxElevationProfile :track="track" />
      <p v-if="track.elevationCount < track.pointCount">Höhe für {{ track.elevationCount.toLocaleString('de-AT') }} von {{ track.pointCount.toLocaleString('de-AT') }} Punkten vorhanden. Fehlende Werte und Abschnittswechsel bleiben im Profil getrennt.</p>
      <div class="gpx__actions">
        <label><input v-model="reference.visible" type="checkbox" /> Track einblenden</label>
        <button type="button" @click="reference.show()">Track zeigen</button>
        <button type="button" @click="reference.remove()">Track entfernen</button>
      </div>
      <p>S = Start, Z = Ziel je Abschnitt. S/Z kennzeichnet eine geschlossene Runde; die Pfeile zeigen die Laufrichtung.</p>
    </template>
    <p>Originaltrack als Referenz für diese Sitzung. Deine geplante Route bleibt erhalten. Nach dem Neuladen die GPX-Datei erneut importieren.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useGpxReferenceStore } from '../../stores/gpx-reference.store';
import { elevationColors, gradientBands, unknownGpxColor } from '../../domain/gpx-inspection';
import GpxElevationProfile from './GpxElevationProfile.vue';

const reference = useGpxReferenceStore();
const { track } = storeToRefs(reference);
const fileInput = ref<HTMLInputElement>();
const legend = computed(() => {
  if (reference.colorMode === 'gradient') return gradientBands;
  const profile = track.value?.profile;
  if (!profile) return [];
  if (profile.minimum === profile.maximum) return [{ color: elevationColors[2], label: `${Math.round(profile.minimum)} m` }];
  return elevationColors.map((color, i) => {
    const from = profile.minimum + (profile.maximum - profile.minimum) * i / elevationColors.length;
    const to = profile.minimum + (profile.maximum - profile.minimum) * (i + 1) / elevationColors.length;
    return { color, label: `${Math.round(from)}–${Math.round(to)} m` };
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
.gpx { padding-block: .75rem; border-bottom: 1px solid #d8e4e1; }
.gpx__heading, .gpx__actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.gpx__heading { justify-content: space-between; }
.gpx h2 { margin: 0; font-size: .9rem; }
.gpx h3 { margin: .75rem 0 .2rem; font-size: .9rem; overflow-wrap: anywhere; }
.gpx p { margin: .5rem 0 0; color: #60757b; font-size: .76rem; line-height: 1.5; overflow-wrap: anywhere; }
.gpx button { padding: .4rem .6rem; min-height: 2.2rem; border: 1px solid #cddbd9; border-radius: .4rem; background: white; color: #16515a; font-size: .75rem; }
.gpx button:hover:not(:disabled) { background: #e9f5f1; border-color: #08796f; }
.gpx input[type=file] { display: none; }
.gpx__actions { margin-top: .75rem; font-size: .75rem; }
.gpx__actions label { display: inline-flex; align-items: center; gap: .3rem; min-height: 2.2rem; }
.gpx dl { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; margin: .75rem 0; }
.gpx dt { color: #60757b; font-size: .72rem; }
.gpx dd { margin: .2rem 0 0; font-size: .9rem; font-weight: 600; }
.gpx .gpx__error { padding: .6rem; border-radius: .4rem; color: #812f23; background: #fff1ed; }
.gpx__color { display: flex; align-items: center; justify-content: space-between; margin-top: .75rem; font-size: .8rem; }
.gpx select { padding: .4rem; background: white; border: 1px solid #cddbd9; border-radius: .4rem; }
.gpx__legend { display: flex; flex-wrap: wrap; gap: .4rem .7rem; margin-top: .5rem; font-size: .7rem; color: #60757b; }
.gpx__legend span { display: inline-flex; align-items: center; gap: .25rem; }
.gpx__legend i { width: .75rem; height: .3rem; border-radius: .1rem; }
</style>

<template>
  <div class="planner">
    <header class="planner__header">
      <span class="planner__eyebrow">GRAZ · RENNRAD</span>
      <h1>RichiRoute</h1>
      <p>Lokales Rennrad-Routing · bevorzugt befestigte Wege.</p>
    </header>

    <div class="planner__draft" aria-live="polite">
      <p v-if="routeStore.draftError" class="planner__error">{{ routeStore.draftError }}</p>
      <p v-else class="planner__help">{{ draftLabel }}</p>
      <button v-if="routeStore.draftError" type="button" @click="saveDraftNow(routeStore)">Aktuelle Route hier speichern</button>
    </div>

    <section class="planner__summary" aria-label="Streckendaten" aria-live="polite">
      <div><strong>{{ distanceLabel }}</strong><span>Distanz</span></div>
      <div><strong>{{ ascentLabel }}</strong><span>Aufstieg</span></div>
    </section>
    <ElevationProfile :points="routeStore.points" :legs="routeStore.legs" />
    <div class="planner__legend" aria-label="Oberflächenfarben">
      <span><i class="surface asphalt" />Asphalt</span>
      <span><i class="surface paved" />Befestigt</span>
      <span><i class="surface rough" />Holprig</span>
      <span><i class="surface unpaved" />Unbefestigt</span>
      <span><i class="surface unknown" />Unbekannt</span>
      <span><i class="surface air" />Luftlinie</span>
    </div>

    <p v-if="hasWeidwegPassage" class="planner__hint" role="status">
      Weidweg: kurze Treppen mit Fahrradrampe. Bitte schieben.
    </p>
    <p v-if="routeStore.errorMessage" class="planner__error" role="alert">{{ routeStore.errorMessage }}</p>
    <button v-if="routeStore.errorMessage" type="button" @click="routeStore.retryRouting()">Erneut versuchen</button>
    <p v-else-if="routeStore.hasAirLines && !routeStore.pendingSnapCount && !routeStore.pendingLegCount" class="planner__hint" role="status">
      Gestrichelte Abschnitte warten auf Routing oder haben keine Straßenverbindung.
    </p>

    <div class="planner__heading">
      <h2>Streckenpunkte</h2>
      <span>{{ routeStore.pendingLegCount || routeStore.pendingSnapCount ? 'Berechnung läuft …' : 'Klick auf die Karte' }}</span>
    </div>
    <ol class="planner__stops">
      <li v-for="(point, index) in routeStore.waypoints" :key="point.id" class="planner__stop">
        <div class="planner__stop-head">
          <label :for="`address-${point.id}`">{{ labelFor(point.kind, index) }}</label>
          <div v-if="point.kind === 'via'" class="planner__stop-actions">
            <button
              type="button"
              :disabled="viaIds.indexOf(point.id) === 0"
              :aria-label="`${labelFor(point.kind, index)} nach oben verschieben`"
              title="Nach oben"
              @click="run(() => routeStore.moveWaypoint(point.id, -1))"
            >↑</button>
            <button
              type="button"
              :disabled="viaIds.indexOf(point.id) === viaIds.length - 1"
              :aria-label="`${labelFor(point.kind, index)} nach unten verschieben`"
              title="Nach unten"
              @click="run(() => routeStore.moveWaypoint(point.id, 1))"
            >↓</button>
            <button
              type="button"
              :aria-label="`${labelFor(point.kind, index)} löschen`"
              title="Stopp löschen"
              @click="run(() => routeStore.removeWaypoint(point.id))"
            >×</button>
          </div>
        </div>
        <AddressSearchInput
          :waypoint-id="point.id"
          :model-value="point.userInput"
          :placeholder="point.kind === 'start' ? 'Start suchen oder Karte anklicken' : 'Adresse suchen oder Karte anklicken'"
          @update:model-value="(value) => routeStore.setWaypointQuery(point.id, value)"
          @item-select="(place) => run(() => routeStore.setWaypointPlace(point.id, place))"
          @text-submit="(query) => run(() => routeStore.searchAndSetWaypointAddress(point.id, query))"
        />
        <small v-if="point.isGeocoding">Adresse wird ermittelt …</small>
        <small v-else-if="point.address && point.address !== point.userInput">Bisher: {{ point.address }}</small>
        <small v-else-if="point.coord && !point.address">
          Punkt: {{ point.coord[1].toFixed(5) }}° N, {{ point.coord[0].toFixed(5) }}° E
        </small>
        <small v-else-if="!point.coord">Noch kein Punkt gesetzt</small>
        <small v-if="point.snapPending">Straßenpunkt wird gesucht …</small>
        <small v-if="point.snapError" role="alert">{{ point.snapError }}</small>
      </li>
    </ol>

    <button
      type="button"
      class="planner__add"
      :disabled="!hasEndpoints"
      @click="addStop"
    >+ Zwischenstopp hinzufügen</button>

    <div class="planner__tools">
      <button type="button" :disabled="!routeStore.canUndo" @click="routeStore.undo()">↶ Rückgängig</button>
      <button type="button" :disabled="!routeStore.canRedo" @click="routeStore.redo()">↷ Wiederholen</button>
      <button
        type="button"
        :disabled="!routeStore.route"
        @click="run(() => routeStore.optimizeEntireRoute())"
      >Gesamte Route optimieren</button>
      <button
        type="button"
        :disabled="!routeStore.shapingPoints.length"
        @click="run(() => routeStore.clearShaping())"
      >Formpunkte entfernen</button>
    </div>
    <button type="button" class="planner__export" :disabled="Boolean(exportReason)" :title="exportReason ?? 'Berechnete Strecke als GPX-Track herunterladen'" @click="downloadGpx">GPX herunterladen</button>
    <p v-if="exportReason && hasEndpoints" class="planner__help">{{ exportReason }}</p>
    <template v-if="!hasEndpoints">
      <button type="button" class="planner__add" @click="run(() => routeStore.resetRoute(westernLoop.coords, westernLoop.shapeIndices))">Beispiel: Westliche Runde über Augasse</button>
      <p class="planner__help">Über ruhige Straßen und Weidweg, mit sechs verschiebbaren Formpunkten. Der Einstieg wird automatisch berechnet.</p>
    </template>
    <button v-if="!hasEndpoints" type="button" class="planner__add" @click="routeStore.resetRoute([[15.474345, 47.090869], [15.503735, 47.105271]])">Beispiel: Hahnhofweg → Roseggerweg</button>
    <button v-else type="button" class="planner__add" @click="routeStore.resetRoute()">Neue Route</button>
    <p class="planner__help">
      Karte anklicken: Start, Ziel, dann Stopps. Auf die Linie klicken: Stopp setzen.
      Linie ziehen: Formpunkt setzen. Nur betroffene Abschnitte werden neu berechnet.
    </p>
    <p class="planner__help">Unbefestigte Abschnitte bleiben möglich und werden farbig markiert. Adresssuche benötigt den optionalen lokalen Suchdienst. Straßenkarte und Luftbilder benötigen Internet.</p>
    <p class="planner__credit">Kartendaten © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap-Mitwirkende</a></p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted } from 'vue';
import { westernLoop } from '@/config/route-examples';
import { usesWeidwegPassage } from '@/domain/local-passages';
import AddressSearchInput from '@/components/common/AddressSearchInput.vue';
import ElevationProfile from '@/components/ui/ElevationProfile.vue';
import { useRouteStore, type Waypoint } from '@/stores/route.store';
import { saveDraftNow } from '@/services/draft.service';
import { exportGpx, gpxUnavailableReason } from '@/domain/route-gpx';

const routeStore = useRouteStore();
const hasWeidwegPassage = computed(() => usesWeidwegPassage(Object.values(routeStore.legs).filter(leg => leg.status === 'routed')));
const exportReason = computed(() => gpxUnavailableReason(routeStore));
const draftLabel = computed(() => ({
  idle: 'Speichert automatisch in diesem Browser.',
  saving: 'Wird in diesem Browser gespeichert …',
  saved: 'In diesem Browser gespeichert.',
  restored: 'Gespeicherte Route wiederhergestellt.',
  error: '',
}[routeStore.draftStatus]));

function downloadGpx() {
  const url = URL.createObjectURL(new Blob([exportGpx(routeStore)], { type: 'application/gpx+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `richiroute-${new Date().toISOString().slice(0, 10)}.gpx`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const viaIds = computed(() => routeStore.waypoints.filter((point) => point.kind === 'via').map((point) => point.id));
const hasEndpoints = computed(() => {
  const stops = routeStore.waypoints;
  return Boolean(stops[0]?.coord && stops[stops.length - 1]?.coord);
});
const distanceLabel = computed(() => {
  if (!routeStore.route) return '—';
  const value = (routeStore.distanceMeters / 1000).toLocaleString('de-AT', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${routeStore.hasAirLines ? 'ca. ' : ''}${value} km`;
});
const ascentLabel = computed(() =>
  routeStore.ascentMeters === null ? '—' : `${Math.round(routeStore.ascentMeters)} hm`);

function labelFor(kind: Waypoint['kind'], index: number): string {
  if (kind === 'start') return 'Start';
  if (kind === 'end') return 'Ziel';
  return `Zwischenstopp ${index}`;
}

async function run(action: () => void | Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error('Editor-Aktion fehlgeschlagen:', error);
    routeStore.errorMessage = error instanceof Error ? error.message : 'Die Aktion konnte nicht ausgeführt werden.';
  }
}

async function addStop(): Promise<void> {
  let id: string | undefined;
  await run(() => { id = routeStore.addIntermediateStopAndPrepare(); });
  await nextTick();
  if (id) document.getElementById(`address-${id}`)?.focus();
}

function onShortcut(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) return;
  if (event.key.toLowerCase() === 'z' && !event.shiftKey && routeStore.canUndo) {
    event.preventDefault();
    routeStore.undo();
  } else if ((event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey)) && routeStore.canRedo) {
    event.preventDefault();
    routeStore.redo();
  }
}

onMounted(() => window.addEventListener('keydown', onShortcut));
onBeforeUnmount(() => window.removeEventListener('keydown', onShortcut));
</script>

<style scoped>
.planner { display: grid; gap: 1rem; padding: 1.4rem; color: #19343c; }
.planner__header h1 { margin: .15rem 0; font-size: 1.85rem; letter-spacing: -.06em; line-height: 1.15; }
.planner__header p, .planner__help { color: #60757b; font-size: .82rem; line-height: 1.5; margin: .2rem 0 0; }
.planner__eyebrow { font-size: .68rem; letter-spacing: .15em; font-weight: 800; color: #0d7d72; }
.planner__summary { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; }
.planner__summary > div { display: grid; gap: .1rem; border: 1px solid #dde7e5; border-radius: .75rem; padding: .75rem .9rem; background: white; }
.planner__summary strong { font-size: 1.3rem; letter-spacing: -.04em; }
.planner__summary span, .planner__heading span { font-size: .73rem; color: #62777b; }
.planner__legend { display: flex; flex-wrap: wrap; column-gap: .75rem; row-gap: .4rem; }
.planner__legend span { display: inline-flex; align-items: center; gap: .25rem; font-size: .67rem; color: #577077; }
.surface { display: inline-block; width: .8rem; height: .24rem; border-radius: .3rem; background: #1d7f69; }
.surface.asphalt { background: #147568; }
.surface.paved { background: #277bb1; }
.surface.rough { background: #bd6f28; }
.surface.unpaved { background: #dc5442; }
.surface.unknown { background: #74818a; }
.surface.air { background: transparent; border-top: 2px dashed #b33c4b; border-radius: 0; }
.planner__error, .planner__hint { margin: 0; padding: .7rem; border-radius: .55rem; font-size: .8rem; line-height: 1.4; }
.planner__error { color: #812f23; background: #fff1ed; }
.planner__hint { color: #68502b; background: #fff7e7; }
.planner__heading { display: flex; justify-content: space-between; align-items: baseline; }
.planner__heading h2 { font-size: 1rem; margin: 0; }
.planner__stops { display: grid; gap: .65rem; margin: 0; padding: 0; list-style: none; }
.planner__stop { padding: .8rem; border: 1px solid #dde7e5; border-radius: .75rem; background: #fff; }
.planner__stop-head { display: flex; align-items: center; justify-content: space-between; min-height: 1.7rem; margin-bottom: .3rem; }
.planner__stop label { font-weight: 700; font-size: .81rem; }
.planner__stop small { display: block; color: #65767a; font-size: .69rem; margin-top: .4rem; }
.planner__stop-actions { display: flex; gap: .2rem; }
.planner__stop-actions button { min-width: 1.9rem; min-height: 1.9rem; font-size: 1.1rem; }
.planner button { cursor: pointer; border: 1px solid #cddbd9; border-radius: .5rem; background: white; color: #16515a; }
.planner button:hover:not(:disabled) { border-color: #08796f; background: #e9f5f1; }
.planner button:focus-visible { outline: 2px solid #086c78; outline-offset: 2px; }
.planner button:disabled { cursor: not-allowed; opacity: .45; }
.planner__add { min-height: 2.6rem; font-weight: 700; }
.planner .planner__export { min-height: 2.7rem; background: #0b706c; color: white; font-weight: 700; }
.planner .planner__export:hover:not(:disabled) { background: #095f5c; }
.planner__draft button { margin-top: .5rem; padding: .5rem; }
.planner__tools { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .5rem; }
.planner__tools button { min-height: 2.5rem; padding: .35rem; font-size: .76rem; }
.planner__tools button:nth-child(3) { grid-column: span 2; background: #0b706c; color: white; border: 0; font-weight: 700; }
.planner__tools button:nth-child(3):hover:not(:disabled) { background: #095f5c; }
.planner__credit { margin: 0; font-size: .65rem; color: #7b8a8e; }
.planner__credit a { color: inherit; text-decoration: underline; }
</style>

<template>
  <div class="planner">
    <section class="planner__section">
      <div class="planner__heading">
        <h2 class="section-title">Streckenpunkte</h2>
        <span class="planner__tools">
          <button type="button" class="btn btn--ghost btn--icon" :disabled="!routeStore.canUndo" aria-label="Rückgängig" title="Rückgängig (Strg+Z)" @click="routeStore.undo()"><IconArrowBackUp :size="18" aria-hidden="true" /></button>
          <button type="button" class="btn btn--ghost btn--icon" :disabled="!routeStore.canRedo" aria-label="Wiederholen" title="Wiederholen (Strg+Y)" @click="routeStore.redo()"><IconArrowForwardUp :size="18" aria-hidden="true" /></button>
          <button type="button" class="btn btn--ghost btn--icon" :disabled="!routeStore.route" aria-label="Gesamte Route optimieren"
            title="Gesamte Route optimieren" @click="run(() => routeStore.optimizeEntireRoute())"><IconWand :size="18" aria-hidden="true" /></button>
          <button type="button" class="btn btn--ghost btn--icon" :disabled="!routeStore.shapingPoints.length" aria-label="Formpunkte entfernen"
            title="Formpunkte entfernen" @click="run(() => routeStore.clearShaping())"><IconEraser :size="18" aria-hidden="true" /></button>
          <button type="button" class="btn btn--ghost btn--icon" :disabled="Boolean(exportReason)" aria-label="GPX herunterladen"
            :title="exportReason ?? 'Route als GPX herunterladen'" @click="downloadGpx"><IconDownload :size="18" aria-hidden="true" /></button>
        </span>
      </div>
      <ol class="planner__stops">
        <li v-for="(point, index) in routeStore.waypoints" :key="point.id" class="planner__stop">
          <span class="planner__badge" :class="{ 'planner__badge--empty': !point.coord }" aria-hidden="true">{{ stopBadge(point.kind, index) }}</span>
          <label :for="`address-${point.id}`" class="label">{{ stopLabel(point.kind, index) }}</label>
          <span v-if="point.kind === 'via'" class="planner__stop-actions">
            <button type="button" class="btn btn--ghost btn--icon btn--sm" :disabled="viaIds.indexOf(point.id) === 0"
              :aria-label="`${stopLabel(point.kind, index)} nach oben verschieben`" title="Nach oben"
              @click="run(() => routeStore.moveWaypoint(point.id, -1))"><IconChevronUp :size="16" aria-hidden="true" /></button>
            <button type="button" class="btn btn--ghost btn--icon btn--sm" :disabled="viaIds.indexOf(point.id) === viaIds.length - 1"
              :aria-label="`${stopLabel(point.kind, index)} nach unten verschieben`" title="Nach unten"
              @click="run(() => routeStore.moveWaypoint(point.id, 1))"><IconChevronDown :size="16" aria-hidden="true" /></button>
            <button type="button" class="btn btn--ghost btn--icon btn--sm" :aria-label="`${stopLabel(point.kind, index)} löschen`" title="Stopp löschen"
              @click="run(() => routeStore.removeWaypoint(point.id))"><IconX :size="16" aria-hidden="true" /></button>
          </span>
          <div class="planner__stop-input">
            <AddressSearchInput
              :waypoint-id="point.id"
              :model-value="point.userInput"
              :placeholder="placeholderFor(point)"
              @update:model-value="(value) => routeStore.setWaypointQuery(point.id, value)"
              @item-select="(place) => run(() => routeStore.setWaypointPlace(point.id, place))"
              @text-submit="(query) => run(() => routeStore.searchAndSetWaypointAddress(point.id, query))"
            />
            <small v-if="point.isGeocoding">Adresse wird ermittelt …</small>
            <small v-else-if="point.address && point.address !== point.userInput">Bisher: {{ point.address }}</small>
            <small v-if="point.snapPending">Straßenpunkt wird gesucht …</small>
            <small v-if="point.snapError" class="planner__stop-error" role="alert">{{ point.snapError }}</small>
          </div>
        </li>
      </ol>
      <button type="button" class="btn btn--ghost planner__add" :disabled="!hasEndpoints" @click="addStop">
        <IconPlus :size="16" aria-hidden="true" />Zwischenstopp hinzufügen
      </button>
    </section>

    <div v-if="routingNotices.length || routeStore.errorMessage || airHint" class="planner__notices">
      <p v-for="notice in routingNotices" :key="notice.id" class="notice notice--warning" role="status">{{ notice.text }}</p>
      <p v-if="routeStore.errorMessage" class="notice notice--error planner__error" role="alert">
        {{ routeStore.errorMessage }}
        <button type="button" class="btn" @click="routeStore.retryRouting()">Erneut versuchen</button>
      </p>
      <p v-else-if="airHint" class="notice notice--warning" role="status">Gestrichelte Abschnitte warten auf Routing oder haben keine Straßenverbindung.</p>
    </div>

    <section v-if="!hasEndpoints" class="planner__section planner__empty">
      <h2 class="section-title">Route planen</h2>
      <p class="muted">Klicke auf die Karte, um Start und Ziel zu setzen, oder suche oben eine Adresse. Danach kannst du die Linie verschieben und Stopps einfügen.</p>
      <div class="planner__examples">
        <button type="button" class="btn" aria-label="Beispiel: Westliche Runde über Augasse"
          title="Über ruhige Straßen und Weidweg, mit sechs verschiebbaren Formpunkten"
          @click="emit('newRoute', westernLoop.coords, westernLoop.shapeIndices)">Westliche Runde über Augasse</button>
        <button type="button" class="btn" aria-label="Beispiel: Hahnhofweg → Roseggerweg"
          @click="emit('newRoute', [[15.474345, 47.090869], [15.503735, 47.105271]])">Hahnhofweg → Roseggerweg</button>
      </div>
    </section>
    <section v-else class="planner__section">
      <dl class="stats planner__stats" aria-label="Streckendaten" aria-live="polite">
        <div><dt>Distanz</dt><dd>{{ distanceLabel }}</dd></div>
        <div><dt>Anstiege</dt><dd>{{ ascentLabel }}</dd></div>
      </dl>
      <SurfaceDetails />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted } from 'vue';
import { IconArrowBackUp, IconArrowForwardUp, IconChevronDown, IconChevronUp, IconDownload, IconEraser, IconPlus, IconWand, IconX } from '@/components/icons';
import { westernLoop } from '@/config/route-examples';
import { localRoutingNotices } from '@/domain/local-routing-notices';
import { isRoutingPolicyCurrent } from '@/config/routing-policy';
import { stopBadge, stopLabel, type Coord } from '@/domain/route-model';
import AddressSearchInput from '@/components/common/AddressSearchInput.vue';
import SurfaceDetails from '@/components/ui/SurfaceDetails.vue';
import { useRouteStore, type Waypoint } from '@/stores/route.store';
import { exportGpx, gpxUnavailableReason } from '@/domain/route-gpx';

const emit = defineEmits<{ newRoute: [coords?: Coord[], shapeIndices?: readonly number[]] }>();
const routeStore = useRouteStore();
const routingNotices = computed(() => localRoutingNotices(Object.values(routeStore.legs)
  .filter(leg => leg.status === 'routed' && isRoutingPolicyCurrent(leg.routingPolicy))));
const airHint = computed(() => routeStore.hasAirLines && !routeStore.routingPending);
const exportReason = computed(() => gpxUnavailableReason(routeStore));

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
  if (!routeStore.route) return '…';
  const value = (routeStore.distanceMeters / 1000).toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${routeStore.hasAirLines ? 'ca. ' : ''}${value} km`;
});
const ascentLabel = computed(() => routeStore.ascentMeters !== null ? `${Math.round(routeStore.ascentMeters).toLocaleString('de-DE')} m`
  : routeStore.routingPending ? '…' : 'unbekannt');

// A point placed on the map without an address shows its position in the empty field.
function placeholderFor(point: Waypoint): string {
  if (point.coord && !point.userInput) return `${point.coord[1].toFixed(5)}° N, ${point.coord[0].toFixed(5)}° E`;
  return point.kind === 'start' ? 'Start suchen oder Karte anklicken' : 'Adresse suchen oder Karte anklicken';
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
.planner { display: flex; flex-direction: column; }
.planner__section { display: grid; gap: .75rem; padding: 1rem var(--gutter); border-bottom: 1px solid var(--border); }
.planner__heading { display: flex; align-items: center; gap: .75rem; }
.planner__tools { display: flex; margin-left: auto; }
.planner__stops { display: grid; gap: .85rem; margin: 0; padding: 0; list-style: none; }
.planner__stop { display: grid; grid-template-columns: 1.5rem minmax(0, 1fr) auto; align-items: center; column-gap: .6rem; row-gap: .3rem; }
.planner__badge { display: grid; place-items: center; width: 1.5rem; height: 1.5rem; border-radius: 50%; background: var(--accent); color: #fff; font-size: .72rem; font-weight: 700; }
.planner__badge--empty { border: 2px dashed var(--border-input); background: none; color: var(--text-muted); }
.planner__stop-actions { display: flex; }
.planner__stop-input { grid-column: 2 / -1; display: grid; gap: .3rem; }
.planner__stop small { color: var(--text-muted); font-size: .75rem; }
.planner__stop .planner__stop-error { color: var(--danger); }
.planner__add { justify-self: start; margin-left: 1.6rem; padding-inline: .5rem; color: var(--accent); }
.planner__notices { display: grid; gap: .5rem; padding: 1rem var(--gutter) 0; }
.planner__empty p { max-width: 34ch; }
.planner__examples { display: flex; flex-wrap: wrap; gap: .5rem; }
.planner__stats dd { font-size: 1.5rem; }
</style>

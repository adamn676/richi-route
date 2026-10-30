<template>
  <div class="planner">
    <section class="planner__section">
      <div class="section-heading">
        <h2 class="text-title-medium">Wegpunkte</h2>
        <span ref="tools" class="planner__tools">
          <v-icon-button :disabled="!routeStore.canUndo" v-tooltip:bottom="'Rückgängig (Strg+Z)'" aria-label="Rückgängig" @click="act(() => routeStore.undo())"><IconArrowBackUp :size="18" aria-hidden="true" /></v-icon-button>
          <v-icon-button :disabled="!routeStore.canRedo" v-tooltip:bottom="'Wiederholen (Strg+Y)'" aria-label="Wiederholen" @click="act(() => routeStore.redo())"><IconArrowForwardUp :size="18" aria-hidden="true" /></v-icon-button>
          <v-icon-button :disabled="!routeStore.shapingPoints.length" aria-label="Formpunkte entfernen"
            v-tooltip:bottom="'Formpunkte entfernen: die weißen Punkte, die die Route formen'" @click="act(() => routeStore.clearShaping())"><IconEraser :size="18" aria-hidden="true" /></v-icon-button>
          <v-icon-button v-tooltip:bottom="'GPX-Datei öffnen (oder auf die Karte ziehen)'" aria-label="GPX-Datei öffnen"
            @click="gpxInput?.click()"><IconFileImport :size="18" aria-hidden="true" /></v-icon-button>
          <input ref="gpxInput" type="file" accept=".gpx,application/gpx+xml,application/xml,text/xml" aria-label="GPX-Datei auswählen" hidden @change="chooseGpx" />
          <!-- On a wrapper, so the reason also shows while the button is disabled. -->
          <span v-tooltip:bottom="exportReason ?? 'Route als GPX herunterladen'"><v-icon-button :disabled="Boolean(exportReason)"
            aria-label="GPX herunterladen" @click="downloadGpx"><IconDownload :size="18" aria-hidden="true" /></v-icon-button></span>
        </span>
      </div>
      <!-- Until the saved route is loaded, its shape stands in for the empty start, which would flash before it. -->
      <ul v-if="!routeStore.draftLoaded" class="planner__skeleton" aria-busy="true" aria-label="Route wird geladen">
        <li v-for="width in [62, 48]" :key="width"><span class="skeleton planner__skeleton-marker" />
          <span class="planner__skeleton-text"><span class="skeleton" style="width: 22%" /><span class="skeleton" :style="{ width: `${width}%` }" /></span></li>
      </ul>
      <div v-else>
        <!-- While a stop is dragged, the rows follow the pointer; the snap into place runs on the drop. -->
        <TransitionGroup tag="ol" name="planner__stop" :move-class="stopDrag ? 'planner__stop-held' : 'planner__stop-move'" class="planner__stops"
          :class="{ 'planner__stops--settling': stopSettling }"
          @enter="(_el: Element, done: () => void) => done()" @leave="(_el: Element, done: () => void) => done()">
          <li v-for="(point, index) in routeStore.waypoints" :key="point.id" class="planner__stop" :data-stop="point.id"
            :class="{ 'planner__stop--lifted': stopDrag?.id === point.id }"
            :style="point.kind === 'via' && stopDrag ? { translate: `0 ${offset(viaIds.indexOf(point.id))}px` } : undefined">
            <button v-if="point.kind === 'via'" type="button" class="planner__grip" :aria-label="`${stopLabel(point.kind, index)} verschieben`"
              @pointerdown="startDrag($event, point.id, viaIds)" @keydown.up.prevent="nudge(point.id, -1)" @keydown.down.prevent="nudge(point.id, 1)">
              <IconGripVertical :size="14" aria-hidden="true" />
            </button>
            <span class="planner__badge" :class="{ 'planner__badge--empty': !point.coord, 'planner__badge--error': routeStore.stopError(point) }" aria-hidden="true">{{ stopBadge(point.kind, index) }}</span>
            <div class="planner__stop-input">
              <AddressSearchInput
                class="field-line"
                :waypoint-id="point.id"
                :label="stopLabel(point.kind, index)"
                :model-value="point.userInput"
                :placeholder="placeholderFor(point)"
                :persistent-placeholder="Boolean(point.coord && !point.userInput)"
                @update:model-value="(value) => routeStore.setWaypointQuery(point.id, value)"
                @item-select="(place) => run(() => routeStore.setWaypointPlace(point.id, place))"
                @text-submit="(query) => run(() => routeStore.searchAndSetWaypointAddress(point.id, query))"
                @clear="run(() => routeStore.clearWaypoint(point.id))"
              />
              <small v-if="point.isGeocoding">Adresse wird ermittelt …</small>
              <small v-else-if="point.address && point.address !== point.userInput">Bisher: {{ point.address }}</small>
              <small v-if="point.snapPending">Straßenpunkt wird gesucht …</small>
              <small v-if="routeStore.stopError(point)" class="planner__stop-error" role="alert">{{ routeStore.stopError(point) }}</small>
            </div>
            <!-- The field's × empties a stop; an intermediate stop goes with its own button, filled or not. -->
            <v-icon-button v-if="point.kind === 'via'" class="planner__remove" size="x-small" :aria-label="`${stopLabel(point.kind, index)} entfernen`"
              v-tooltip:bottom="'Zwischenstopp entfernen'" @click="removeStop(point.id)"><IconTrash :size="16" aria-hidden="true" /></v-icon-button>
          </li>
        </TransitionGroup>
        <button v-if="hasEndpoints" type="button" class="planner__add" aria-label="Zwischenstopp hinzufügen"
          v-tooltip:end="'Zwischenstopp hinzufügen'" @click="addStop"><span class="planner__add-mark" aria-hidden="true"><IconPlus :size="14" /></span></button>
      </div>
      <!-- Until the rider has changed a route on the map once, it says how; offered loops take the map's clicks instead. -->
      <p v-if="routeStore.route && !shaped && !routeStore.shapingPoints.length && !viaIds.length && !loops.suggestions" class="text-body-small text-medium-emphasis">
        {{ touch ? 'Tipp: Route auf der Karte gedrückt halten und ziehen, um sie zu formen; Antippen setzt einen Zwischenstopp.'
          : 'Tipp: Route auf der Karte ziehen, um sie zu formen; ein Klick darauf setzt einen Zwischenstopp.' }}</p>
    </section>

    <!-- Errors of the whole route; a stop shows its own in its row. -->
    <div v-if="routingNotices.length || problem" class="planner__notices">
      <v-alert v-for="notice in routingNotices" :key="notice.id" type="warning" role="status">{{ notice.text }}</v-alert>
      <v-alert v-if="problem" type="error" class="planner__error">
        {{ problem.message }}
        <div class="planner__error-actions">
          <v-btn v-if="problem.section" @click="routeStore.showSection(problem.section)">Abschnitt zeigen</v-btn>
          <v-btn v-if="problem.retry" @click="routeStore.retryRouting()">Erneut versuchen</v-btn>
        </div>
      </v-alert>
    </div>

    <LoopSuggestions v-if="routeStore.draftLoaded && (!hasEndpoints || loops.suggestions)" />
    <!-- Distance and climbing are in the elevation profile's header, which stays in view. -->
    <section v-if="hasEndpoints" class="planner__section"><SurfaceDetails /></section>
    <!-- A removed stop can come back at once. -->
    <v-snackbar v-model="removed" :timeout="5000">
      Zwischenstopp entfernt
      <template #actions><v-btn variant="text" color="inverse-primary" aria-label="Entfernten Zwischenstopp zurückholen" @click="restoreStop">Rückgängig</v-btn></template>
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconArrowBackUp, IconArrowForwardUp, IconDownload, IconEraser, IconFileImport, IconGripVertical, IconPlus, IconTrash } from '@/components/icons';
import { localRoutingNotices } from '@/domain/local-routing-notices';
import { isRoutingPolicyCurrent } from '@/config/routing-policy';
import { stopBadge, stopLabel } from '@/domain/route-model';
import AddressSearchInput from '@/components/common/AddressSearchInput.vue';
import SurfaceDetails from '@/components/ui/SurfaceDetails.vue';
import LoopSuggestions from '@/components/ui/LoopSuggestions.vue';
import { useRouteStore, type Waypoint } from '@/stores/route.store';
import { useLoopSuggestionsStore } from '@/stores/loop-suggestions.store';
import { exportGpx, gpxUnavailableReason } from '@/domain/route-gpx';
import { useStopDragging } from '@/composables/useStopDragging';

// A chosen GPX file opens as the route (AppSidebar).
const emit = defineEmits<{ 'open-gpx': [file: File] }>();
const routeStore = useRouteStore();
const loops = useLoopSuggestionsStore();
const routingNotices = computed(() => localRoutingNotices(Object.values(routeStore.legs)
  .filter(leg => leg.status === 'routed' && isRoutingPolicyCurrent(leg.routingPolicy))));
const problem = computed(() => routeStore.routeProblem);
const exportReason = computed(() => gpxUnavailableReason(routeStore));
const touch = matchMedia('(hover: none)').matches;
const shapedKey = 'richiroute.route-shaped';
const shaped = ref((() => { try { return localStorage.getItem(shapedKey) === '1'; } catch { return false; } })());
routeStore.$onAction(({ name }) => {
  if (shaped.value || (name !== 'insertShapingPoint' && name !== 'insertWaypointOnRoute')) return;
  shaped.value = true;
  try { localStorage.setItem(shapedKey, '1'); } catch { /* Storage may be disabled. */ }
});

const gpxInput = ref<HTMLInputElement>();
function chooseGpx(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) emit('open-gpx', file);
}
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
// The offer to undo a removal ends with the next step in the history; the route's recalculation is none.
const removed = ref(false);
let removal: unknown;
async function removeStop(id: string) {
  await run(() => routeStore.removeWaypoint(id));
  removal = routeStore.undoStack;
  removed.value = true;
}
watch(() => routeStore.undoStack, stack => { if (stack !== removal) removed.value = false; });
function restoreStop() {
  removed.value = false;
  routeStore.undo();
}
// Moving a stop keeps the focus where it is: on its grip, which moves along.
const { drag: stopDrag, settling: stopSettling, start: startDrag, offset } = useStopDragging((id, to) => run(() => routeStore.moveWaypointTo(id, to)));
function nudge(id: string, direction: -1 | 1) {
  const to = viaIds.value.indexOf(id) + direction;
  if (to >= 0 && to < viaIds.value.length) void run(() => routeStore.moveWaypointTo(id, to));
}
const hasEndpoints = computed(() => {
  const stops = routeStore.waypoints;
  return Boolean(stops[0]?.coord && stops[stops.length - 1]?.coord);
});
// A point placed on the map without an address shows its position in the empty field.
function placeholderFor(point: Waypoint): string {
  if (point.coord && !point.userInput) return `${point.coord[1].toFixed(5)}° N, ${point.coord[0].toFixed(5)}° E`;
  return `${{ start: 'Start', via: 'Stopp', end: 'Ziel' }[point.kind]} suchen oder Karte ${touch ? 'antippen' : 'anklicken'}`;
}

async function run(action: () => void | Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error('Editor-Aktion fehlgeschlagen:', error);
    routeStore.errorMessage = error instanceof Error ? error.message : 'Die Aktion konnte nicht ausgeführt werden.';
  }
}

// A button that disables itself (the last undo, the last shaping point removed) leaves the focus in the toolbar.
const tools = ref<HTMLElement>();
async function act(action: () => void): Promise<void> {
  await run(action);
  await nextTick();
  const focused = document.activeElement;
  if (!focused || focused === document.body || (focused as HTMLButtonElement).disabled) tools.value?.querySelector<HTMLElement>('button:enabled')?.focus();
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
/* On a 4 px grid: a 24 px marker column at the edge, text 36 px in; headings 36 px tall with 12 px to their content; stop
   rows with the address line from 25 to 49 px and its field line 10 px under the address's baseline, list rows 44 px; hover
   areas 8 px wider than the content. */
/* One column no wider than the panel: wide content shrinks or wraps instead of stretching it past its edge. */
/* Measured to the letters: 24 px from the line above to a heading's capitals (12 px padding, 12 inside the heading row)
   and 24 px from the last item to the line below. */
.planner__section { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-3); padding: var(--space-3) var(--gutter-end) var(--space-4) var(--gutter); }
/* Sections are parted by a line from margin to margin; rows within one by lines from their text column on. */
.planner__section ~ .planner__section { background: linear-gradient(var(--border), var(--border)) no-repeat var(--gutter) 0 / calc(100% - var(--gutter) - var(--gutter-end)) 1px; }
/* The last tool's glyph, not its 36 px target, ends at the margin, as the other edges' glyphs do. */
.planner__tools { display: flex; align-items: center; margin-left: auto; margin-right: -9px; }
.planner__tools > span { display: flex; }
/* Six tools beside the heading fit the narrowest panel at 36 px each. */
.planner__tools :deep(.v-btn) { width: 36px; height: 36px; }
/* The first row's own padding is taken back, so the first label sits 12 px under the heading, as in every section. */
.planner__stops { display: grid; margin: calc(-1 * var(--space-2)) 0 0; padding: 0; list-style: none; }
/* Marker, field (its label above the address) and an intermediate stop's trash button; the button's column is kept in
   every row, so that the fields' × line up. */
.planner__stop { position: relative; display: grid; grid-template-columns: 24px minmax(0, 1fr) 24px; align-items: start; column-gap: var(--space-3);
  padding: var(--space-2) 0; transition: translate .16s cubic-bezier(.2, .8, .2, 1), box-shadow .16s, background-color .16s; }
/* Dots from marker to marker, with some room around each. */
.planner__stop:not(:last-child)::after { content: ''; position: absolute; top: 55px; bottom: -19px; left: 10px; width: 4px;
  background: radial-gradient(circle, color-mix(in srgb, var(--text-muted) 70%, transparent) 1.3px, transparent 1.7px) center top / 4px 7px repeat-y; }
.planner__badge { display: grid; place-items: center; width: 24px; height: 24px; margin-top: 17px; border-radius: 50%; background: var(--accent);
  color: #fff; font-size: .72rem; font-weight: 700; }
.planner__badge--empty { border: 2px dashed var(--border-input); background: none; color: var(--text-muted); }
.planner__badge--error { background: var(--danger); }
.planner__stop-input { grid-column: 2; grid-row: 1; display: grid; gap: .3rem; }
/* Vuetify's input adds 8 px above the address line: 9 + 8 put it 17 px below the row's padding, level with the marker,
   10 px under its label's baseline; its line lies 10 px under the address's baseline, as in every field. */
.planner__stop-input :deep(.v-field--variant-plain) { --v-field-padding-top: 9px; --v-field-padding-bottom: 0px; }
.planner__stop-input .field-line { padding-bottom: 4px; }
.planner__stop-input :deep(.v-field-label--floating) { top: 0; transform: none; color: var(--text-muted); opacity: 1; }
/* The × level with the address line (the input sits 8 px below the field's padding, the × half of that), its icon flush
   with the right edge, as the Untergrund figures are. */
.planner__stop-input :deep(.v-field__clearable) { align-items: center; padding-top: var(--v-field-padding-top); padding-bottom: var(--v-field-padding-bottom);
  margin-inline-end: calc(-1 * var(--space-2)); color: var(--text-muted); }
.planner__stop-input :deep(.v-field__clearable > *) { translate: 0 var(--space-1); }
.planner__stop small { color: var(--text-muted); font-size: .75rem; }
.planner__stop .planner__stop-error { color: var(--danger); }
.planner__remove { grid-column: 3; grid-row: 1; align-self: start; width: 32px; max-width: none; margin: 13px -8px 0 0; color: var(--text-muted); }
.planner__grip { position: absolute; top: 37px; left: -18px; display: flex; padding: var(--space-1) 0; border: 0; background: none;
  color: var(--text-muted); opacity: .75; transform: translateY(-50%); cursor: grab; touch-action: none; }
.planner__grip:active { cursor: grabbing; }
/* Dragging a stop: lifted under the pointer, the others making room; the drop snaps it into place by the list's move
   transition alone. */
.planner__stop--lifted { z-index: 3; border-radius: var(--radius); background: var(--surface); transition: box-shadow .16s, background-color .16s;
  box-shadow: 0 0 0 var(--space-2) var(--surface), 0 6px 18px var(--space-2) rgb(16 24 22 / .14), 0 1px 3px var(--space-2) rgb(16 24 22 / .1); }
.planner__stop--lifted::after { display: none; }
.planner__stops--settling .planner__stop, .planner__stop-move { transition: transform .26s cubic-bezier(.2, 1.1, .3, 1.15); }
@media (prefers-reduced-motion: reduce) { .planner__stop, .planner__stops--settling .planner__stop, .planner__stop-move { transition: none; } }
/* The next stop's empty marker in the marker column, inside a round 44 px target. */
.planner__add { display: grid; place-items: center; width: 40px; height: 40px; margin-left: -8px; padding: 0; border: 0; border-radius: 50%;
  background: none; color: var(--text-muted); cursor: pointer; }
.planner__add:hover { background: color-mix(in srgb, var(--border) 40%, transparent); color: var(--text); }
.planner__add-mark { display: grid; place-items: center; width: 24px; height: 24px; border: 1.5px dashed var(--border-input); border-radius: 50%; }
.planner__notices { display: grid; gap: var(--space-2); padding: var(--space-4) var(--gutter-end) 0 var(--gutter); }
.planner__error-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-2); }
/* Without surfaces to show, their section takes no room. */
.planner__section:empty { display: none; }
.planner__skeleton { display: grid; margin: 0; padding: 0; list-style: none; }
.planner__skeleton li { display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: end; column-gap: var(--space-3); min-height: 64px;
  padding: var(--space-2) 0; }
.planner__skeleton-marker { width: 24px; height: 24px; border-radius: 50%; }
.planner__skeleton-text { display: grid; gap: var(--space-2); }
.planner__skeleton-text .skeleton { height: .7rem; }
.planner__skeleton-text .skeleton + .skeleton { height: 1rem; }
</style>

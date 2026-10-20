<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import ComparisonMap from './ComparisonMap.vue';
import RouteInspector from './RouteInspector.vue';
import type { RouteInspection } from './route-inspection';
import type { Result, Run, RunSummary, Scenario } from './types';
import thalPreference from '../../../src/config/thal-preference.json';

const initialView = new URLSearchParams(location.search);
const scenarios = ref<Scenario[]>([]);
const caseId = ref(initialView.get('case') ?? '01-mur-north');
const split = ref('tuning');
const runs = ref<RunSummary[]>([]);
const run = ref<Run | null>(null);
const runId = ref('');
const busy = ref(false);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const variant = ref('automatic');
const highlighted = ref('');
const inspection = ref<RouteInspection | null>(null);
const inspectionError = ref('');
const inspectionLoading = ref(false);
const cursorIndex = ref<number | null>(null);
const sectionIndex = ref<number | null>(null);
const showSurfaces = ref(false);
const selectedOnly = ref(false);
const showGraphhopper = ref(true);
const showBrouter = ref(true);
const showOrs = ref(true);
const includeOrs = ref(false);
const engineNames = { graphhopper: 'GraphHopper', brouter: 'BRouter', ors: 'OpenRouteService' };
const scenario = computed(() => scenarios.value.find((item) => item.id === caseId.value));
const storedScenario = computed(() => run.value?.scenarios.find((item) => item.id === caseId.value));
const displayedScenario = computed(() => storedScenario.value ?? scenario.value);
const thalLocal = computed(() => caseId.value === '04-thal-surface' && run.value?.settings === 'thal-local-v1');
const thalReviewed = computed(() => thalLocal.value && run.value?.id === thalPreference.reviewRunId && variant.value === 'automatic');
const olderScenario = computed(() => storedScenario.value && (storedScenario.value.revision ?? 1) < (scenario.value?.revision ?? 1));
const filteredScenarios = computed(() => scenarios.value.filter((item) => item.split === split.value));
const availableRuns = computed(() => runs.value.filter((item) => [caseId.value, split.value, 'all'].includes(item.scope)));
const results = computed(() => run.value?.results.filter((item) => item.caseId === caseId.value && item.variant === variant.value) ?? []);
const focused = computed(() => results.value.find((item) => item.id === highlighted.value));
const repetition = computed(() => focused.value?.repetition ?? 1);
const visibleRoutes = computed(() => results.value.filter((item) => item.repetition === repetition.value && (selectedOnly.value ? item.id === highlighted.value : { graphhopper: showGraphhopper.value, brouter: showBrouter.value, ors: showOrs.value }[item.engineId])));
const hasOrs = computed(() => results.value.some(item => item.engineId === 'ors'));
const points = computed(() => {
  const source = displayedScenario.value;
  if (!source) return [];
  if (variant.value === 'automatic') return source.points.filter((point) => point.role === 'stop');
  if (variant.value === 'edited' && source.edit) return source.points.map((point, index) => index === source.edit?.pointIndex ? { ...point, coord: source.edit.coord } : point);
  return source.points;
});
const review = reactive({ reviewer: '', locationsReviewed: false, unwantedM: '', corrections: '', requiredRoadsKept: '', distantRoadsKept: '', notes: '' });
let loadRevision = 0;
let initialized = false;
let inspectionRevision = 0;

function selectSection(index: number) {
  sectionIndex.value = index;
  cursorIndex.value = inspection.value?.sections[index]?.fromIndex ?? null;
  showSurfaces.value = true;
}

function showRoutes(onlySelected: boolean) {
  selectedOnly.value = onlySelected;
  showSurfaces.value = false;
  if (!onlySelected) {
    showGraphhopper.value = true;
    showBrouter.value = true;
    showOrs.value = true;
  }
}

function selectRoute(result: Result) {
  highlighted.value = result.id;
  showSurfaces.value = false;
  if (result.engineId === 'graphhopper') showGraphhopper.value = true;
  if (result.engineId === 'brouter') showBrouter.value = true;
  if (result.engineId === 'ors') showOrs.value = true;
}

async function loadInspection() {
  const revision = ++inspectionRevision;
  inspection.value = null;
  inspectionError.value = '';
  cursorIndex.value = null;
  sectionIndex.value = null;
  inspectionLoading.value = !!focused.value;
  if (!focused.value || !run.value) return;
  try {
    const data = await api<RouteInspection>(`/route-inspection?run=${encodeURIComponent(run.value.id)}&result=${encodeURIComponent(focused.value.id)}`);
    if (revision === inspectionRevision) inspection.value = data;
  } catch (cause) { if (revision === inspectionRevision) inspectionError.value = message(cause); }
  finally { if (revision === inspectionRevision) inspectionLoading.value = false; }
}

function updateViewLink() {
  if (!initialized) return;
  const url = new URL(location.href);
  url.searchParams.set('case', caseId.value);
  url.searchParams.set('variant', variant.value);
  if (runId.value) url.searchParams.set('run', runId.value);
  else url.searchParams.delete('run');
  history.replaceState(null, '', url);
}

async function api<T>(url: string, payload?: unknown): Promise<T> {
  const response = await fetch(`/api${url}`, payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Request failed.');
  return data;
}

async function loadRun(id: string) {
  const revision = ++loadRevision;
  runId.value = id;
  error.value = '';
  run.value = null;
  if (!id) { loading.value = false; return; }
  loading.value = true;
  try {
    const saved = await api<Run>(`/run?id=${encodeURIComponent(id)}`);
    if (revision === loadRevision) run.value = saved;
  } catch (cause) { if (revision === loadRevision) error.value = message(cause); }
  finally { if (revision === loadRevision) loading.value = false; }
}

function loadLatest() {
  return loadRun(availableRuns.value[0]?.id ?? '');
}

function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Request failed.'; }
function distance(result: Result) { return result.normalized?.distanceM == null ? 'Unknown' : `${(result.normalized.distanceM / 1000).toFixed(2)} km`; }
function percent(value: number | null | undefined) { return value == null ? 'Unknown' : `${value.toFixed(1)}%`; }
function hasElevation(result: Result) {
  return result.normalized?.geometry.coordinates.some(coord => Number.isFinite(coord[2]) && coord[2] !== -32768) ?? false;
}

async function compare() {
  busy.value = true;
  error.value = '';
  notice.value = 'Comparing local engines. Requests and responses are saved on this computer.';
  ++loadRevision;
  try {
    const saved = await api<Run>('/run', { caseId: caseId.value, settings: run.value?.settings ?? 'baseline', includeOrs: includeOrs.value, evaluationFreeze: run.value?.evaluationFreeze });
    run.value = saved;
    runId.value = saved.id;
    runs.value = await api<RunSummary[]>('/runs');
    notice.value = saved.status === 'completed' ? 'Comparison saved. Select a route to review it.' : 'Comparison saved with routing errors. See the results below.';
  } catch (cause) { error.value = message(cause); notice.value = ''; }
  finally { busy.value = false; }
}

async function saveReview() {
  if (!run.value || !focused.value) return;
  error.value = '';
  const boolean = (value: string) => value === '' ? null : value === 'yes';
  try {
    await api('/review', {
      runId: run.value.id, resultId: focused.value.id,
      review: { ...review, unwantedM: review.unwantedM === '' ? null : Number(review.unwantedM), corrections: review.corrections === '' ? null : Number(review.corrections), requiredRoadsKept: boolean(review.requiredRoadsKept), distantRoadsKept: boolean(review.distantRoadsKept) },
    });
    notice.value = 'Review saved in this run\'s local reviews folder.';
  } catch (cause) { error.value = message(cause); }
}

function exportRun() {
  if (!run.value) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(run.value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `richiroute-${run.value.id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

watch(split, () => { if (initialized) caseId.value = filteredScenarios.value[0]?.id ?? ''; });
watch(caseId, () => { if (initialized) { variant.value = 'automatic'; notice.value = ''; void loadLatest(); } });
watch([caseId, variant, runId], updateViewLink, { flush: 'post' });
watch(results, () => { highlighted.value = (results.value.find(item => item.engineId === 'brouter' && item.status === 'ok') ?? results.value.find(item => item.status === 'ok'))?.id ?? ''; });
watch([highlighted, run], loadInspection);
watch(run, saved => { if (saved) includeOrs.value = saved.includeOrs ?? false; });
watch(highlighted, () => {
  Object.assign(review, { locationsReviewed: false, unwantedM: '', corrections: '', requiredRoadsKept: '', distantRoadsKept: '', notes: '' });
});

onMounted(async () => {
  try {
    const [suite, savedRuns] = await Promise.all([api<{ scenarios: Scenario[] }>('/scenarios'), api<RunSummary[]>('/runs')]);
    scenarios.value = suite.scenarios;
    runs.value = savedRuns;
    if (!scenario.value) throw new Error('The linked scenario does not exist. Open the main page to choose a scenario.');
    split.value = scenario.value.split;
    await nextTick();
    const requestedRun = initialView.get('run');
    if (requestedRun && !availableRuns.value.some((saved) => saved.id === requestedRun)) {
      throw new Error('The linked comparison is unavailable for this scenario. Choose a saved comparison.');
    }
    await (requestedRun ? loadRun(requestedRun) : loadLatest());
    const requestedVariant = initialView.get('variant');
    if (requestedVariant === 'selected' || (requestedVariant === 'edited' && displayedScenario.value?.edit)) variant.value = requestedVariant;
  } catch (cause) { error.value = message(cause); }
  finally { initialized = true; loading.value = false; updateViewLink(); }
});
</script>

<template>
  <header class="app-header">
    <a class="brand" href="/">RichiRoute<span>Route review</span></a>
    <p>Graz &amp; Styria <span class="cost">EUR 0 service charges</span></p>
  </header>
  <main class="workspace">
    <aside class="sidebar">
      <div class="sidebar-primary">
      <div class="review-heading"><span class="draft-label">{{ thalReviewed ? 'Reviewed' : 'Needs your review' }}</span><span v-if="run?.evaluationFreeze" class="fixed-settings">Settings fixed</span></div>
      <h1>{{ displayedScenario?.title ?? 'Which route would you ride?' }}</h1>
      <label for="scenario">Road-cycling scenario</label>
      <select id="scenario" v-model="caseId" :disabled="busy"><option v-for="item in filteredScenarios" :key="item.id" :value="item.id">{{ item.id.slice(0, 2) }} · {{ item.title }}</option></select>
      <p class="review-question">{{ thalReviewed ? 'This route is accepted. No repeat review is needed.' : displayedScenario?.reviewQuestion }}</p>
      <section class="route-choices" aria-label="Choose a route to inspect">
        <h2>Route details</h2>
        <button v-for="result in results" :key="result.id" :class="['route-choice', result.engineId]" :aria-pressed="highlighted === result.id" :disabled="result.status !== 'ok'" @click="selectRoute(result)">
          <span class="route-choice-name"><i :class="['line-key', result.engineId]" />{{ engineNames[result.engineId] }}<strong>{{ distance(result) }}</strong></span>
          <span v-if="result.status === 'ok'" class="route-choice-meta">{{ hasElevation(result) ? 'Elevation available' : 'No elevation in this run' }}<span>{{ percent(result.normalized?.unknownSurfacePercent) }} surface unknown</span></span>
          <span v-else class="error">{{ result.error }}</span>
        </button>
      </section>
      <p class="selection-help">Select a route to highlight it on the map and view its details. Use Next difference to compare the alternatives.</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <p v-if="loading" role="status">Loading saved comparisons…</p>
      <p v-else-if="!results.length" class="empty">No saved routes for this view. Open comparison setup to calculate them.</p>
      </div>
      <div class="sidebar-secondary">
      <details v-if="focused?.status === 'ok'" class="review-form">
          <summary>Record a rider review</summary>
          <form @submit.prevent="saveReview">
            <p>Reviewing {{ engineNames[focused.engineId] }}, {{ variant }} route. Leave unmeasured values blank.</p>
            <div class="form-grid">
              <label>Reviewer<input v-model="review.reviewer" required maxlength="100" autocomplete="name" /></label>
              <label>Unwanted sections, metres<input v-model="review.unwantedM" type="number" min="0" step="any" /></label>
              <label>Corrections needed<input v-model="review.corrections" type="number" min="0" step="1" /></label>
              <label>Chosen roads kept<select v-model="review.requiredRoadsKept"><option value="">Not reviewed</option><option value="yes">Yes</option><option value="no">No</option></select></label>
              <label>Distant roads kept after edit<select v-model="review.distantRoadsKept"><option value="">Not reviewed / not applicable</option><option value="yes">Yes</option><option value="no">No</option></select></label>
            </div>
            <label>Roads, unwanted sections and corrections<textarea v-model="review.notes" rows="3" maxlength="5000"></textarea></label>
            <label class="checkbox-label"><input v-model="review.locationsReviewed" type="checkbox" required />I checked the draft locations and intended roads.</label>
            <button type="submit" class="primary compact">Save review</button>
          </form>
        </details>
      <details class="comparison-setup">
        <summary>Comparison setup</summary>
        <label for="split">Scenario set</label>
        <select id="split" v-model="split" :disabled="busy"><option value="tuning">Tuning · 6 drafts</option><option value="evaluation">Evaluation · 6 held-out drafts</option></select>
        <label for="saved-run">Saved comparison</label>
        <select id="saved-run" :value="runId" :disabled="busy || loading" @change="loadRun(($event.target as HTMLSelectElement).value)">
          <option value="">No saved comparison selected</option>
          <option v-for="saved in availableRuns" :key="saved.id" :value="saved.id">{{ new Date(saved.createdAt).toLocaleString() }} · {{ saved.settings ?? 'Baseline' }} · {{ saved.status }}</option>
        </select>
        <p v-if="run?.evaluationFreeze" class="hint">Settings fixed for this evaluation. Record problems without changing the routing settings during this round.</p>
        <p class="settings-label hint">{{ run?.settingsLabel ?? 'Baseline profiles' }}</p>
        <label class="checkbox-label engine-option"><input v-model="includeOrs" type="checkbox" :disabled="busy || loading || !!run?.evaluationFreeze" />Include local OpenRouteService</label>
        <button class="primary" :disabled="busy || loading || !scenario" @click="compare">{{ busy ? 'Comparing…' : 'Compare routes' }}</button>
        <button class="secondary" :disabled="!run || busy" @click="exportRun">Export run JSON</button>
      </details>
      <details class="method-notes">
        <summary>Scenario notes &amp; method</summary>
        <p>{{ displayedScenario?.focus }}</p>
        <p v-if="thalLocal" class="revision-note">Your accepted Thalstraße preference is active. Automatic uses only the endpoints; the path remains available when deliberately selected.</p>
        <p v-else-if="displayedScenario?.revisionNote" class="revision-note">Scenario revision {{ displayedScenario.revision }}. {{ displayedScenario.revisionNote }}</p>
        <p v-if="olderScenario">Showing the original saved route, before the scenario correction.</p>
        <p>Draft locations need review. Surface tags do not establish current road conditions or legal access.</p>
        <p>Orange: GraphHopper. Blue: BRouter. Turquoise: OpenRouteService. The selected route is drawn on top. Shared stretches appear once; alternative branches remain visible. Selected only hides the alternatives.</p>
        <p>Shared geometry uses a 3 m display tolerance and matching travel direction. Next difference groups nearby differences into review areas; it does not change or grade the saved routes.</p>
        <p>GraphHopper and ORS have no elevation in these saved runs. Each engine uses its own map data and surface categories.</p>
        <p>Selected and edited routes use whole-route requests. Check whether roads elsewhere changed after an edit.</p>
      </details>
      </div>
    </aside>
    <section class="comparison" aria-label="Map and route details">
      <div class="map-toolbar">
        <div class="variant-controls" aria-label="Route variant">
          <button v-for="option in ['automatic', 'selected', ...(displayedScenario?.edit ? ['edited'] : [])]" :key="option" :aria-pressed="variant === option" @click="variant = option">{{ { automatic: 'Automatic', selected: 'Chosen roads', edited: 'After an edit' }[option] }}</button>
        </div>
        <div class="route-display-controls" role="group" aria-label="Routes shown on map">
          <button :aria-pressed="!selectedOnly && !showSurfaces" @click="showRoutes(false)">All routes</button>
          <button :aria-pressed="selectedOnly && !showSurfaces" :disabled="!focused" @click="showRoutes(true)">Selected only</button>
        </div>
      </div>
      <div class="view-context">
        <span>{{ variant === 'automatic' ? 'Automatic · Start and destination only' : `${points.filter(point => point.role === 'shape').length} shaping points` }}</span>
        <div v-if="!showSurfaces && !selectedOnly" class="legend">
          <label><input v-model="showGraphhopper" type="checkbox" /><span class="line-key graphhopper" />GraphHopper</label>
          <label><input v-model="showBrouter" type="checkbox" /><span class="line-key brouter" />BRouter</label>
          <label v-if="hasOrs"><input v-model="showOrs" type="checkbox" aria-label="OpenRouteService" /><span class="line-key ors" />ORS</label>
        </div>
        <strong v-else-if="selectedOnly && !showSurfaces">{{ focused ? engineNames[focused.engineId] : '' }} only</strong>
        <span v-else class="surface-map-label">Surface map · {{ focused ? engineNames[focused.engineId] : '' }}</span>
      </div>
      <p v-if="displayedScenario?.accessNote" class="access-note">{{ displayedScenario.accessNote.text }} <a :href="displayedScenario.accessNote.sourceUrl" target="_blank" rel="noopener">Source</a></p>
      <p v-for="result in results.filter(item => item.riderRejection)" :key="result.id" class="rider-rejection" role="status"><strong>{{ engineNames[result.engineId] }} rejected by rider.</strong> {{ result.riderRejection?.reason }}</p>
      <ComparisonMap :points="points" :routes="visibleRoutes" :highlighted="highlighted" :inspection="inspection" :cursor="cursorIndex" :section="sectionIndex" :show-surfaces="showSurfaces" @section="selectSection" />
      <RouteInspector v-if="inspection && focused" :data="inspection" :engine="engineNames[focused.engineId]" :cursor="cursorIndex" :section="sectionIndex" :surfaces="showSurfaces" @cursor="cursorIndex = $event; sectionIndex = null" @section="selectSection" @surfaces="showSurfaces = $event" />
      <p v-else-if="inspectionLoading" class="inspection-loading" role="status">Loading elevation and surface sections…</p>
      <p v-else-if="inspectionError" class="error" role="alert">{{ inspectionError }} <button @click="loadInspection">Retry details</button></p>
      <details class="results-panel">
        <summary>Benchmark details</summary>
        <div v-if="results.length" class="table-scroll">
          <table>
            <caption>{{ variant === 'automatic' ? 'Automatic route choice' : variant === 'selected' ? 'Deliberately selected roads' : 'Route after moving one shaping point' }}</caption>
            <thead><tr><th scope="col">Engine</th><th scope="col">Distance</th><th scope="col">Response</th><th scope="col">Unknown surface</th><th scope="col">Review</th></tr></thead>
            <tbody><tr v-for="result in results" :key="result.id" :class="{ focused: highlighted === result.id }">
              <th scope="row"><span :class="['line-key', result.engineId]"></span>{{ engineNames[result.engineId] }}<small v-if="result.repetition > 1">Repeat {{ result.repetition }}</small><small v-if="result.riderRejection" class="rejection-label">Rejected: unpaved route</small></th>
              <template v-if="result.status === 'ok'"><td>{{ distance(result) }}</td><td>{{ Math.round(result.responseMs) }} ms</td><td>{{ percent(result.normalized?.unknownSurfacePercent) }}</td><td><button class="text-button" :aria-pressed="highlighted === result.id" @click="selectRoute(result)">{{ highlighted === result.id ? 'Selected' : 'Review' }}</button></td></template>
              <td v-else colspan="4" class="error">{{ result.error }}</td>
            </tr></tbody>
          </table>
        </div>

        <p v-if="focused?.normalized" class="hint">{{ focused.normalized.attributeNote }}</p>
      </details>
    </section>
  </main>
</template>

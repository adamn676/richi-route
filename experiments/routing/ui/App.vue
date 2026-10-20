<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import ComparisonMap from './ComparisonMap.vue';
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
const visibleRoutes = computed(() => results.value.filter((item) => item.repetition === (focused.value?.repetition ?? 1) && ({ graphhopper: showGraphhopper.value, brouter: showBrouter.value, ors: showOrs.value }[item.engineId])));
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

async function compare() {
  busy.value = true;
  error.value = '';
  notice.value = 'Comparing local engines. Requests and responses are saved on this computer.';
  ++loadRevision;
  try {
    const saved = await api<Run>('/run', { caseId: caseId.value, settings: run.value?.settings ?? 'baseline', includeOrs: includeOrs.value });
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
watch(results, () => { highlighted.value = results.value.find((item) => item.status === 'ok')?.id ?? ''; });
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
    <a class="brand" href="/">RichiRoute<span>Road-cycling lab</span></a>
    <p>Graz &amp; Styria <span class="separator">/</span> Local engines <span class="cost">EUR 0 service charges</span></p>
  </header>
  <main class="workspace">
    <aside class="sidebar">
      <h1>Which route would you ride?</h1>
      <p class="intro">Compare automatic routes and roads you deliberately select.</p>
      <label for="split">Scenario set</label>
      <select id="split" v-model="split" :disabled="busy"><option value="tuning">Tuning · 6 drafts</option><option value="evaluation">Evaluation · 6 held-out drafts</option></select>
      <label for="scenario">Road-cycling scenario</label>
      <select id="scenario" v-model="caseId" :disabled="busy"><option v-for="item in filteredScenarios" :key="item.id" :value="item.id">{{ item.id.slice(0, 2) }}. {{ item.title }}</option></select>
      <div v-if="displayedScenario" class="scenario-brief">
        <span class="draft-label">{{ thalReviewed ? 'Rider accepted' : 'Needs your review' }}</span>
        <h2>{{ displayedScenario.title }}</h2>
        <p>{{ displayedScenario.focus }}</p>
        <p v-if="scenario?.accessNote" class="access-note">{{ scenario.accessNote.text }} <a :href="scenario.accessNote.sourceUrl" target="_blank" rel="noopener">City notice</a> · Checked {{ scenario.accessNote.checkedDate }}</p>
        <p v-if="thalLocal" class="revision-note">Your accepted preference for Thalstraße beside the narrow path is active in the main editor. Automatic uses only the start and destination. The path remains available when deliberately selected.</p>
        <p v-else-if="displayedScenario.revisionNote" class="revision-note">Scenario revision {{ displayedScenario.revision }}: {{ displayedScenario.revisionNote }}</p>
        <p v-if="olderScenario" class="error" role="status">Showing the original saved route, before the scenario correction. {{ scenario?.revisionNote }} Select the latest saved comparison or use Compare routes to run the corrected scenario.</p>
        <p class="review-question">{{ thalReviewed ? 'Reviewed and accepted on 20 October 2026. No repeat review is needed for this route.' : displayedScenario.reviewQuestion }}</p>
      </div>
      <label class="checkbox-label engine-option"><input v-model="includeOrs" type="checkbox" :disabled="busy || loading" />Include local OpenRouteService</label>
      <button type="button" class="primary" :disabled="busy || loading || !scenario" @click="compare">{{ busy ? 'Comparing…' : 'Compare routes' }}</button>
      <p class="hint">Runs GraphHopper, BRouter{{ includeOrs ? ' and local ORS' : '' }} for automatic, selected and, where available, edited routes.</p>
      <label for="saved-run">Saved comparison</label>
      <select id="saved-run" :value="runId" :disabled="busy || loading" @change="loadRun(($event.target as HTMLSelectElement).value)">
        <option value="">No saved comparison selected</option>
        <option v-for="saved in availableRuns" :key="saved.id" :value="saved.id">{{ new Date(saved.createdAt).toLocaleString() }} · {{ saved.settings && saved.settings !== 'baseline' ? saved.settings : 'Baseline' }} · {{ saved.status }}</option>
      </select>
      <button type="button" class="secondary" :disabled="!run || busy" @click="exportRun">Export run JSON</button>
      <details class="method-notes">
        <summary>How to read this experiment</summary>
        <p>All locations are generated drafts. A returned route does not establish surface quality, legal access or rider suitability.</p>
        <p>Green is GraphHopper. Dashed orange is BRouter. Dotted blue is local OpenRouteService when included. Small hollow markers are shaping points; solid markers are stops.</p>
        <p>Selected and edited routes use whole-route requests. Check whether roads elsewhere changed after an edit.</p>
        <p>GraphHopper has no elevation in this baseline. BRouter uses prepared elevation. Their datasets also differ.</p>
        <p v-if="hasOrs">Local ORS uses cycling-road and the same Styria map extract as GraphHopper, without elevation. This tests the engine separately from the original editor's dragging logic.</p>
        <p>Use tuning cases to adjust profiles. Keep evaluation cases separate and freeze settings before scoring them.</p>
      </details>
    </aside>
    <section class="comparison">
      <div class="map-toolbar">
        <div class="variant-controls" aria-label="Route variant">
          <button v-for="option in ['automatic', 'selected', ...(displayedScenario?.edit ? ['edited'] : [])]" :key="option" :aria-pressed="variant === option" @click="variant = option">{{ { automatic: 'Automatic', selected: 'Chosen roads', edited: 'After an edit' }[option] }}</button>
        </div>
        <div class="legend">
          <label><input v-model="showGraphhopper" type="checkbox" /><span class="line-key graphhopper"></span>GraphHopper</label>
          <label><input v-model="showBrouter" type="checkbox" /><span class="line-key brouter"></span>BRouter</label>
          <label v-if="hasOrs"><input v-model="showOrs" type="checkbox" /><span class="line-key ors"></span>OpenRouteService</label>
        </div>
      </div>
      <div v-if="displayedScenario" class="view-context">
        <strong>{{ caseId.slice(0, 2) }} · {{ variant === 'automatic' ? 'Automatic' : variant === 'selected' ? 'Chosen roads' : 'After an edit' }}</strong>
        <span>{{ variant === 'automatic' ? 'Start and destination only. No chosen-road points are applied.' : `${points.filter(point => point.role === 'shape').length} chosen-road points applied. Check the route between them too.` }}</span>
        <span class="settings-label">{{ thalLocal ? 'BRouter surface v4 + accepted local Thal preference' : run?.settingsLabel ?? 'Baseline profiles' }}{{ !thalLocal && run?.settings && run.settings !== 'baseline' ? ' · Experimental, awaiting rider review' : '' }}</span>
      </div>
      <p v-for="result in results.filter(item => item.riderRejection)" :key="result.id" class="rider-rejection" role="status">
        <strong>{{ engineNames[result.engineId] }} rejected by rider.</strong> {{ result.riderRejection?.reason }}
      </p>
      <ComparisonMap :points="points" :routes="visibleRoutes" :highlighted="highlighted" />
      <div class="results-panel">
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-if="notice" class="notice" role="status">{{ notice }}</p>
        <p v-if="loading" role="status">Loading saved comparisons…</p>
        <p v-else-if="!results.length" class="empty">No results for this view yet. Choose a scenario and compare routes.</p>
        <div v-else class="table-scroll">
          <table>
            <caption>{{ variant === 'automatic' ? 'Automatic route choice' : variant === 'selected' ? 'Deliberately selected roads' : 'Route after moving one shaping point' }}</caption>
            <thead><tr><th scope="col">Engine</th><th scope="col">Distance</th><th scope="col">Response</th><th scope="col">Unknown surface</th><th scope="col">Review</th></tr></thead>
            <tbody><tr v-for="result in results" :key="result.id" :class="{ focused: highlighted === result.id }">
              <th scope="row"><span :class="['line-key', result.engineId]"></span>{{ engineNames[result.engineId] }}<small v-if="result.repetition > 1">Repeat {{ result.repetition }}</small><small v-if="result.riderRejection" class="rejection-label">Rejected: unpaved route</small></th>
              <template v-if="result.status === 'ok'"><td>{{ distance(result) }}</td><td>{{ Math.round(result.responseMs) }} ms</td><td>{{ percent(result.normalized?.unknownSurfacePercent) }}</td><td><button class="text-button" :aria-pressed="highlighted === result.id" @click="highlighted = result.id">{{ highlighted === result.id ? 'Selected' : 'Review' }}</button></td></template>
              <td v-else colspan="4" class="error">{{ result.error }}</td>
            </tr></tbody>
          </table>
        </div>
        <p v-if="focused?.normalized" class="hint">{{ focused.normalized.attributeNote }}</p>
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
      </div>
    </section>
  </main>
</template>

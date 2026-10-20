import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { engines, route, variants } from './engines.mjs';
import { candidateProfile, settingsFor } from './profiles.mjs';
import { validateEvaluation } from './evaluation.mjs';

export const root = fileURLToPath(new URL('.', import.meta.url));
const runsRoot = path.join(root, '.local/runs');
export const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
export const loadScenarios = () => readJson(path.join(root, 'scenarios.json'));

async function saveJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n');
  await rename(temp, file);
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function provenance(settings, includeOrs) {
  const assets = await readJson(path.join(root, '.local/assets.json'));
  const brouterPatch = await readJson(path.join(root, '.local/brouter/patch.json'));
  if (brouterPatch.patch !== engines.brouter.patch ||
      await sha256(path.join(root, '.local/brouter/brouter-ries-bicycle-turn-v1.jar')) !== brouterPatch.patchedJarSha256) {
    throw new Error('BRouter patch differs from its recorded build. Run npm run bench:brouter:patch before comparing.');
  }
  for (const asset of assets.assets) {
    if (await sha256(path.join(root, '.local', asset.file)) !== asset.sha256) throw new Error(`Asset changed: ${asset.file}. Run setup and investigate before comparing.`);
  }
  const snapshots = {};
  const files = ['graphhopper.yml', 'compose.yml', 'scenarios.json', 'engines.mjs', 'profiles.mjs', 'run.mjs', 'evaluation.mjs', 'brouter-patch/OsmNode.java', '.local/brouter/profiles2/richi-road.brf', '.local/brouter/profiles2/lookups.dat'];
  files.push('../../src/config/thal-preference.json');
  if (includeOrs) files.push('ors.yml', 'ors-patch/Dockerfile', 'ors-patch/ORSOSMReader.java');
  if (settings !== 'baseline') files.push(`.local/brouter/profiles2/${settingsFor(settings).brouterProfile}.brf`);
  for (const file of files) {
    const content = await readFile(path.join(root, file), 'utf8');
    snapshots[file] = { sha256: createHash('sha256').update(content).digest('hex'), content };
  }
  const git = (...args) => {
    try {
      return execFileSync('git', ['-c', `safe.directory=${path.resolve(root, '../..').replaceAll('\\', '/')}`, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { return null; }
  };
  let graphhopperInfo;
  try {
    const response = await fetch('http://127.0.0.1:8989/info', { redirect: 'error', signal: AbortSignal.timeout(3000) });
    graphhopperInfo = response.ok ? await response.json() : { error: `HTTP ${response.status}` };
  } catch (error) { graphhopperInfo = { error: error.message }; }
  let orsInfo;
  if (includeOrs) {
    try {
      const response = await fetch('http://127.0.0.1:8082/ors/v2/status', { redirect: 'error', signal: AbortSignal.timeout(3000) });
      orsInfo = response.ok ? await response.json() : { error: `HTTP ${response.status}` };
    } catch (error) { orsInfo = { error: error.message }; }
  }
  return {
    assets, snapshots, graphhopperInfo, brouterPatch,
    ...(includeOrs ? { orsInfo } : {}),
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    git: { commit: git('rev-parse', 'HEAD'), status: git('status', '--short') },
    limitations: [
      'Generated draft coordinates and expected roads require Richard\'s review. Successful routing is not evidence of road-bike suitability.',
      'GraphHopper uses a Styria PBF; BRouter uses a larger prepared tile. Source dates, processing and coverage differ.',
      'HTTP Last-Modified is not the OSM source timestamp. GraphHopper reports the PBF data_date in graphhopperInfo. The RD5 source OSM timestamp is unknown.',
      'GraphHopper has no elevation in this baseline. BRouter uses prepared elevation and fastbike defaults. Grade preferences are not comparable.',
      'Selected and edited routes are whole-route requests with ordered shaping points. They do not guarantee preservation of distant roads.',
      'No warm-up or automatic retries. First-request and filesystem cache effects are included in wall-clock latency.',
      'Surface coverage uses GraphHopper geometry lengths or BRouter message distances. Unknown surface is not proof of unpaved road, and known surface is not proof of suitability.',
      ...(includeOrs ? ['ORS uses the same Styria PBF as GraphHopper, with its own cycling-road defaults and no elevation. Its local version and configuration may differ from the hosted service used by the original app. This comparison does not execute the original editor’s radius/bearing or shaping logic. ORS surface coverage uses geometry lengths and numeric surface codes.'] : []),
    ],
  };
}

/** @param {{ split?: string, caseId?: string, settings?: string, repetitions?: number, includeOrs?: boolean, evaluationFreeze?: string, onProgress?: (message: string) => void }} options */
export async function runBenchmark({ split = 'tuning', caseId, settings = 'baseline', repetitions = 1, includeOrs = false, evaluationFreeze, onProgress = () => {} } = {}) {
  const preset = settingsFor(settings);
  if (typeof includeOrs !== 'boolean') throw new Error('includeOrs must be a boolean.');
  const engineIds = includeOrs ? ['graphhopper', 'brouter', 'ors'] : ['graphhopper', 'brouter'];
  if (!['tuning', 'evaluation', 'all'].includes(split)) throw new Error('Split must be tuning, evaluation or all.');
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('Repetitions must be an integer from 1 to 10.');
  const suite = await loadScenarios();
  const cases = suite.scenarios.filter((item) => caseId ? item.id === caseId : split === 'all' || item.split === split);
  if (!cases.length) throw new Error('No matching scenario.');
  if (evaluationFreeze !== undefined && (typeof evaluationFreeze !== 'string' || !validId(evaluationFreeze))) throw new Error('Invalid evaluation freeze ID.');
  if (evaluationFreeze && cases.some(scenario => scenario.split !== 'evaluation')) throw new Error('A frozen evaluation must contain only evaluation cases.');
  if (settings !== 'baseline') {
    if (!evaluationFreeze && cases.some(scenario => scenario.split !== 'tuning')) throw new Error('Experimental settings are limited to tuning cases until frozen.');
    const profile = candidateProfile(await readFile(path.join(root, '.local/brouter/profiles2/richi-road.brf'), 'utf8'), settings);
    const target = path.join(root, `.local/brouter/profiles2/${preset.brouterProfile}.brf`);
    try { await writeFile(target, profile, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await readFile(target, 'utf8') !== profile) throw new Error('Candidate profile changed on disk; preserve it and create a new settings version.');
    }
  }
  const evidence = await provenance(settings, includeOrs);
  let frozen;
  if (evaluationFreeze) {
    frozen = await readJson(path.join(root, '.local/evaluations', `${evaluationFreeze}.json`));
    validateEvaluation(frozen, settings, includeOrs, evidence);
  }
  const run = {
    schemaVersion: 1,
    id: new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(), status: 'running', scope: caseId ?? split,
    suiteStatus: suite.status, settings, settingsLabel: preset.label + (includeOrs ? '; local ORS cycling-road baseline' : ''),
    engines: { graphhopper: engines.graphhopper, brouter: { ...engines.brouter, profile: preset.brouterProfile }, ...(includeOrs ? { ors: engines.ors } : {}) },
    includeOrs,
    ...(frozen ? { evaluationFreeze, evaluationFingerprint: frozen.fingerprint } : {}),
    provenance: evidence, scenarios: cases, results: [],
  };
  const directory = path.join(runsRoot, run.id);
  await mkdir(directory, { recursive: true });
  await saveJson(path.join(directory, 'run.json'), run);
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const scenario of cases) {
      for (const variant of variants(scenario)) {
        const order = repetition % 2 ? engineIds : [...engineIds].reverse();
        for (const engineId of order) {
          const resultId = `${scenario.id}-${variant.name}-${engineId}-${repetition}`;
          const result = await route(engineId, variant.points, fetch, settings);
          const { rawText, ...summary } = result;
          if (rawText !== null) await writeFile(path.join(directory, `${resultId}.response.txt`), rawText);
          await saveJson(path.join(directory, `${resultId}.request.json`), result.request);
          run.results.push({ id: resultId, caseId: scenario.id, split: scenario.split, variant: variant.name, engineId, repetition, points: variant.points, ...summary });
          await saveJson(path.join(directory, 'run.json'), run);
          onProgress(`${resultId}: ${result.status}, ${Math.round(result.responseMs)} ms`);
        }
      }
    }
  }
  run.status = run.results.some((result) => result.status === 'error') ? 'completed-with-errors' : 'completed';
  run.completedAt = new Date().toISOString();
  await saveJson(path.join(directory, 'run.json'), run);
  return run;
}

const validId = (id) => /^[a-zA-Z0-9-]+$/.test(id);
export async function readRun(id) {
  if (!validId(id)) throw new Error('Invalid run ID.');
  return readJson(path.join(runsRoot, id, 'run.json'));
}

export async function listRuns() {
  let entries;
  try { entries = await readdir(runsRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const runs = [];
  for (const entry of entries.filter((entry) => entry.isDirectory() && validId(entry.name))) {
    const run = await readRun(entry.name);
    runs.push({ id: run.id, createdAt: run.createdAt, scope: run.scope, status: run.status, resultCount: run.results.length, settings: run.settings ?? 'baseline', settingsLabel: run.settingsLabel ?? 'Baseline profiles' });
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function validateReview(review) {
  if (!review || typeof review.reviewer !== 'string' || !review.reviewer.trim() || review.reviewer.length > 100 || review.locationsReviewed !== true) throw new Error('Enter a reviewer and confirm that you checked the draft locations.');
  for (const key of ['unwantedM', 'corrections']) {
    if (review[key] !== null && (!Number.isFinite(review[key]) || review[key] < 0 || (key === 'corrections' && !Number.isInteger(review[key])))) throw new Error(`Invalid ${key}. Leave unmeasured values blank.`);
  }
  for (const key of ['requiredRoadsKept', 'distantRoadsKept']) {
    if (![true, false, null].includes(review[key])) throw new Error(`Invalid ${key}.`);
  }
  if (typeof review.notes !== 'string' || review.notes.length > 5000) throw new Error('Notes must be at most 5000 characters.');
  return { reviewer: review.reviewer.trim(), locationsReviewed: true, unwantedM: review.unwantedM, corrections: review.corrections, requiredRoadsKept: review.requiredRoadsKept, distantRoadsKept: review.distantRoadsKept, notes: review.notes };
}

export async function saveReview(runId, resultId, review) {
  const checked = validateReview(review);
  const run = await readRun(runId);
  const result = run.results.find((item) => item.id === resultId);
  if (!result || result.status !== 'ok') throw new Error('Only a successful route can be reviewed.');
  const directory = path.join(runsRoot, runId, 'reviews');
  await mkdir(directory, { recursive: true });
  const record = { runId, resultId, ...checked, reviewedAt: new Date().toISOString() };
  await saveJson(path.join(directory, `${randomUUID()}.json`), record);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = { '--split': 'split', '--case': 'caseId', '--settings': 'settings', '--repetitions': 'repetitions', '--include-ors': 'includeOrs', '--evaluation-freeze': 'evaluationFreeze' }[args[i]];
    if (!name || !args[i + 1]) throw new Error('Usage: npm run bench:run -- [--split tuning|evaluation|all] [--case ID] [--settings NAME] [--repetitions 1..10] [--include-ors true|false] [--evaluation-freeze ID]');
    if (name === 'includeOrs' && !['true', 'false'].includes(args[i + 1])) throw new Error('--include-ors must be true or false.');
    options[name] = name === 'repetitions' ? Number(args[i + 1]) : name === 'includeOrs' ? args[i + 1] === 'true' : args[i + 1];
  }
  const run = await runBenchmark({ ...options, onProgress: console.log });
  console.log(`Saved ${run.id}: ${run.status}`);
  if (run.status !== 'completed') process.exitCode = 1;
}

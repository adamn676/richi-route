import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readRun } from './run.mjs';
import { compareGeometry, referenceFromSegments } from './tuning-geometry.mjs';

const local = new URL('./.local/', import.meta.url);
const readJson = async name => JSON.parse(await readFile(new URL(name,local),'utf8'));
const ids = await readJson('cyclepath-v1-runs.json');
const feedback = await readJson('feedback/03-eggenberg-junction-selected-2026-10-18.json');
const original03 = await readRun(feedback.runId);
const originalAll = await readRun('2026-10-17T20-32-45-933Z-72a1c9bd');
const reference03 = referenceFromSegments(original03,feedback);
const result = (run,caseId,engine,variant='automatic') => run.results.find(r=>r.caseId===caseId && r.engineId===engine && r.variant===variant);
const geometry = result => result.normalized.geometry.coordinates;
const report = {settings:'cyclepath-v1',createdAt:new Date().toISOString(),runs:ids,references:{scenario03:reference03.properties,scenario02:{runId:originalAll.id,resultId:'02-parallel-mur-automatic-graphhopper-1',assessment:'User accepted the shared automatic route.'}},results:[],limitations:[
  'Reference 03 combines the earlier rider-selected segments. Subsequent whole-route acceptance is recorded separately in feedback/03-eggenberg-junction-cyclepath-v1-accepted-2026-10-18.json and applies only to that saved Chosen roads result.',
  'Geometry comparisons sample every five metres in both directions and check length and endpoints. They are not access, traffic or safety scores.',
  'Automatic scenario 03 is not yet the intended route at the start. Chosen roads still supplies four explicit shaping points.',
  'Scenario 01 changed and needs rider review. Held-out evaluation cases were not used.',
]};
for(const [caseId,id] of Object.entries(ids)) {
  const run = await readRun(id);
  assert.equal(run.settings,'cyclepath-v1');
  assert.equal(run.status,'completed');
  assert.equal(run.engines.graphhopper.profile,'racingbike');
  assert.equal(run.engines.brouter.profile,'richi-cyclepath-v1');
  const baselineFile='.local/brouter/profiles2/richi-road.brf';
  assert.equal(run.provenance.snapshots[baselineFile].sha256,originalAll.provenance.snapshots[baselineFile].sha256);
  assert.equal(run.provenance.snapshots['graphhopper.yml'].sha256,originalAll.provenance.snapshots['graphhopper.yml'].sha256);
  for(const variant of caseId.startsWith('03') ? ['automatic','selected'] : ['automatic']) {
    const br=result(run,caseId,'brouter',variant);
    const reference=caseId.startsWith('03') ? reference03.geometry.coordinates : geometry(result(originalAll,caseId,'graphhopper'));
    const measurement=compareGeometry(geometry(br),reference);
    report.results.push({caseId,variant,engine:'brouter',resultId:br.id,...measurement});
    if(caseId.startsWith('02') || (caseId.startsWith('03') && variant==='selected')) {
      assert.ok(measurement.maximumSampledSeparationM<1,'Candidate must follow the accepted geometry within one metre.');
      assert.ok(Math.abs(measurement.lengthDifferenceM)<2,'No extra backtracking or shortcuts.');
      assert.ok(measurement.startSeparationM<1 && measurement.endSeparationM<1,'Same route direction and endpoints.');
    }
  }
}
const source = await readFile(new URL('./tuning-geometry.mjs',import.meta.url));
report.measurementSourceSha256=createHash('sha256').update(source).digest('hex');
await writeFile(new URL('cyclepath-v1-reference03.geojson',local),JSON.stringify(reference03,null,2));
await writeFile(new URL('cyclepath-v1-checks.json',local),JSON.stringify(report,null,2));
for(const row of report.results) console.log(`${row.caseId} ${row.variant}: ${row.maximumSampledSeparationM.toFixed(2)} m maximum sampled separation; ${row.lengthDifferenceM.toFixed(2)} m length difference`);
console.log('Passed: scenario 03 Chosen roads matches the selected segments; scenario 02 Automatic retains the accepted route; baseline profiles preserved.');

// Search quality against fixed cases (tests/search-cases.json): where the correct place ranks among the suggestions, the
// name given to points on the map and to loops. Each run is saved by name and compared with an earlier one:
//   node tests/search-quality.mjs <name> [--compare <earlier name>] [--verify]
// SEARCH_URL points to the search service (default: the local one on port 2322). --verify only checks that each expected place
// exists in the data, by searching with more context, so no case asks for the impossible.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { forwardGeocode, reverseGeocode, townAt } from '../src/services/geocoding.service.ts';

const service = process.env.SEARCH_URL ?? 'http://127.0.0.1:2322';
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => realFetch(String(url).replace(/^\/geocoding/, service), options);

const args = process.argv.slice(2);
const name = args.find(arg => !arg.startsWith('--')) ?? 'current';
const compareTo = args.includes('--compare') ? args[args.indexOf('--compare') + 1] : null;
const cases = JSON.parse(await readFile(new URL('./search-cases.json', import.meta.url), 'utf8'));
const output = new URL('../.cache/search-quality/', import.meta.url);
const signal = () => AbortSignal.timeout(10000);

if (args.includes('--verify')) {
  const missing = [];
  for (const c of cases.forward) {
    const responses = await Promise.all([c.query, `${c.query} Steiermark`].map(q => realFetch(`${service}/api/?${new URLSearchParams({
      q, lang: 'de', limit: '50', lat: String(cases.focus[1]), lon: String(cases.focus[0]) })}`).then(r => r.json())));
    const labels = responses.flatMap(response => response.features).map(f => [f.properties.name, [f.properties.street, f.properties.housenumber].filter(Boolean).join(' '),
      [f.properties.postcode, f.properties.city].filter(Boolean).join(' '), f.properties.state].filter((p, i, all) => p && all.indexOf(p) === i).join(', '));
    if (!labels.some(label => new RegExp(c.expect).test(label))) missing.push(`${c.query} (${c.expect})`);
  }
  console.log(missing.length ? `Not in the data:\n  ${missing.join('\n  ')}` : 'Every expected place exists in the data.');
  process.exit(0);
}

const results = { forward: [], reverse: [], towns: [] };
for (const c of cases.forward) {
  const started = performance.now();
  let places = [], error = null;
  try { places = await forwardGeocode(c.query, signal(), cases.focus); } catch (cause) { error = cause.message; }
  const rank = places.findIndex(place => new RegExp(c.expect).test(place.label)) + 1;
  results.forward.push({ ...c, rank, ms: Math.round(performance.now() - started), first: places[0]?.label ?? error ?? '–', count: places.length });
}
for (const kind of ['reverse', 'towns']) for (const c of cases[kind]) {
  const answer = await (kind === 'reverse' ? reverseGeocode : townAt)(c.point, signal()).catch(cause => `Fehler: ${cause.message}`);
  results[kind].push({ ...c, answer: answer ?? '–', ok: new RegExp(c.expect).test(answer ?? '') });
}

const forward = results.forward, n = forward.length;
const share = count => `${count}/${n} (${Math.round(count / n * 100)} %)`;
const summary = {
  first: forward.filter(r => r.rank === 1).length, top3: forward.filter(r => r.rank && r.rank <= 3).length,
  found: forward.filter(r => r.rank).length, names: [...results.reverse, ...results.towns].filter(r => r.ok).length,
  nameCases: results.reverse.length + results.towns.length,
  medianMs: forward.map(r => r.ms).sort((a, b) => a - b)[Math.floor(n / 2)],
};
console.log(`== ${name}: first ${share(summary.first)}, top 3 ${share(summary.top3)}, found ${share(summary.found)}; ` +
  `map and loop names ${summary.names}/${summary.nameCases}; median ${summary.medianMs} ms`);
for (const group of [...new Set(forward.map(r => r.group))]) {
  const rows = forward.filter(r => r.group === group);
  console.log(`  ${group.padEnd(13)} first ${rows.filter(r => r.rank === 1).length}/${rows.length}, top 3 ${rows.filter(r => r.rank && r.rank <= 3).length}/${rows.length}`);
}
for (const r of forward.filter(r => r.rank !== 1)) console.log(`  ${r.rank ? `#${r.rank}` : 'fehlt'.padEnd(2)}  „${r.query}“ → erst: ${r.first}`);
for (const r of [...results.reverse, ...results.towns].filter(r => !r.ok)) console.log(`  falsch  ${r.group} ${r.point} → ${r.answer}`);

await mkdir(output, { recursive: true });
await writeFile(new URL(`${name}.json`, output), JSON.stringify({ name, date: new Date().toISOString(), service, summary, results }, null, 2));

if (compareTo) {
  const before = JSON.parse(await readFile(new URL(`${compareTo}.json`, output), 'utf8'));
  const rank = r => r.rank || 99;
  const worse = forward.filter(r => { const b = before.results.forward.find(x => x.query === r.query); return b && rank(r) > rank(b); });
  const better = forward.filter(r => { const b = before.results.forward.find(x => x.query === r.query); return b && rank(r) < rank(b); });
  console.log(`\n== compared with ${compareTo}: ${better.length} better, ${worse.length} worse`);
  for (const r of worse) console.log(`  schlechter  „${r.query}“: #${before.results.forward.find(x => x.query === r.query).rank || '–'} → #${r.rank || '–'} (erst: ${r.first})`);
  assert.equal(worse.length, 0, 'No case may get worse than the version compared with');
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import config from '../../config/routing-rules.json' with { type: 'json' };
import search from '../../src/config/routing-search.json' with { type: 'json' };
import { compileRules } from '../../scripts/routing-rules.mjs';
import { nativeManifest, nativeReportDirectory, startNativeRouter } from './native-router.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const modes = process.argv.includes('--quick') ? [0, 10000] : [0, 1000, 10000];
const rounds = process.argv.includes('--quick') ? 3 : 6;
const cases = [nativeManifest.cases.find(c => c.name === 'Graz-Virgen'),
  { name: 'Virgen-Mistelbach', coords: [[12.456876612333161, 47.00334492589846], [16.5768, 48.5707]] }];
await mkdir(nativeReportDirectory, { recursive: true });
const variants = [{ name: 'previous-engine', legacy: true, port: 17782 }];
for (const count of modes) {
  const data = structuredClone(config);
  for (let i = 0; i < count; i++) {
    const a = [15.01 + ((i * 15485863) % 4980000) / 1e6, 45.01 + ((i * 32452843) % 4980000) / 1e6].map(v => Math.round(v * 1e6) / 1e6);
    const b = [Math.round((a[0] + .000001) * 1e6) / 1e6, a[1]];
    const kind = i % 3;
    const rule = structuredClone(config.rules[kind]);
    rule.id = `benchmark-${i}`;
    rule.reason = 'Synthetic benchmark fixture, never activated in the editor.';
    if (kind === 0) rule.segments = [[a, b]];
    else if (kind === 1) { rule.from = a; rule.via = b; rule.to = [b[0], Math.round((b[1] + .000001) * 1e6) / 1e6]; }
    else { rule.center = a; rule.radiusMeters = .001; }
    data.rules.push(rule);
  }
  const compiled = compileRules(data);
  const file = path.join(nativeReportDirectory, `scale-${count}.tsv`);
  await writeFile(file, compiled.engine);
  variants.push({ name: `rules-${count + config.rules.length}`, count: data.rules.length, rulesFile: file,
    parameters: compiled.client.parameters, port: 17783 + variants.length });
}
const report = { createdAt: new Date().toISOString(), scope: 'Warmed native JVMs, identical runtime/search/data, alternating order. First two rounds warm up; remaining rounds measured. Extra rules are a mixture of passages, directed turns and avoidance circles across the existing tile.',
  search, rounds, samples: [], summaries: [] };
const running = [];
try {
  for (const variant of variants) running.push(await startNativeRouter({ ...variant,
    javaArgs: [`-XX:StartFlightRecording=filename=${path.join(nativeReportDirectory, variant.name + '.jfr')},settings=profile,dumponexit=true`] }));
  for (const item of cases) {
    let expected;
    for (let round = 0; round < rounds; round++) {
      const order = variants.map((_, i) => variants[(i + round) % variants.length]);
      for (const variant of order) {
        const query = new URLSearchParams({ profile: variant.legacy ? 'richi-weidweg-v1' : 'richi-local-v1',
          lonlats: item.coords.map(c => c.join(',')).join('|'), format: 'geojson', alternativeidx: '0' });
        if (variant.legacy) query.set('nogos', nativeManifest.nogos);
        for (const [key, value] of Object.entries({ ...search, ...variant.parameters })) query.set('profile:' + key, String(value));
        const started = performance.now();
        const response = await fetch(`http://127.0.0.1:${variant.port}/brouter?${query}`, { signal: AbortSignal.timeout(70000) });
        const body = await response.text(), elapsedMs = performance.now() - started;
        assert.ok(response.ok, body);
        const raw = JSON.parse(body);
        for (const feature of raw.features) if (feature.properties?.name) feature.properties.name = feature.properties.name.replace('brouter_richi-local-v1_', 'brouter_richi-weidweg-v1_');
        const digest = hash(raw.features); expected ??= digest;
        assert.equal(digest, expected, 'Full route features, except the profile name, must match');
        report.samples.push({ route: item.name, variant: variant.name, round, warmup: round < 2, elapsedMs, hash: digest });
        console.log(JSON.stringify(report.samples.at(-1)));
        await writeFile(path.join(nativeReportDirectory, 'scale-benchmark.json'), JSON.stringify(report, null, 2) + '\n');
      }
    }
    for (const variant of variants) {
      const samples = report.samples.filter(s => s.route === item.name && s.variant === variant.name && !s.warmup).map(s => s.elapsedMs);
      report.summaries.push({ route: item.name, variant: variant.name, medianMs: median(samples), minMs: Math.min(...samples), maxMs: Math.max(...samples) });
    }
  }
} finally {
  for (const router of running) await router.stop();
  await writeFile(path.join(nativeReportDirectory, 'scale-benchmark.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report.summaries, null, 2));

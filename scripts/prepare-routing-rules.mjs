import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRules, validateLookupTags } from './routing-rules.mjs';
import { localRulesProfile } from './routing-profile.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = path.resolve(process.env.BROUTER_BUNDLE ?? path.join(root, '../richiroute-ubuntu-benchmark'));
const configFile = path.resolve(process.env.ROUTING_RULES_CONFIG ?? path.join(root, 'config/routing-rules.json'));
const output = path.resolve(process.env.ROUTING_RULES_OUTPUT ?? path.join(root, 'experiments/routing/.local/local-routing-rules'));
const data = JSON.parse(await readFile(configFile, 'utf8'));
const compiled = compileRules(data);
const active = data.rules.filter(r => r.enabled);
const reviewed = new Map(active.flatMap(r => Object.entries(r.reviewedTiles)));
for (const [tile, expected] of reviewed) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(bundle, 'data', tile))) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error(`Map data changed: ${tile}. Review these local rules before updating their tile checksums: ${active.filter(r => tile in r.reviewedTiles).map(r => r.id).join(', ')}`);
}

const bundleManifest = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
const baseProfile = await readFile(path.join(bundle, 'profiles/richi-weidweg-v1.brf'), 'utf8');
const lookups = await readFile(path.join(bundle, 'profiles/lookups.dat'), 'utf8');
for (const [file, text] of [['profiles/richi-weidweg-v1.brf', baseProfile], ['profiles/lookups.dat', lookups]]) {
  if (createHash('sha256').update(text).digest('hex') !== bundleManifest.files[file]) throw new Error(`Base routing asset changed: ${file}. Review the profile/data migration first.`);
}
validateLookupTags(data, lookups);
const profile = localRulesProfile(baseProfile, compiled.retainedTags);
const profiles = path.join(output, 'profiles');
await mkdir(profiles, { recursive: true });
async function replace(file, text) {
  try { if (await readFile(file, 'utf8') === text) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(file + '.tmp', text);
  await rename(file + '.tmp', file);
}
await replace(path.join(output, 'rules.tsv'), compiled.engine);
await replace(path.join(profiles, 'richi-local-v1.brf'), profile);
await copyFile(path.join(bundle, 'profiles/lookups.dat'), path.join(profiles, 'lookups.dat'));
// Keep the historical profiles available for explicit comparisons.
const original = baseProfile;
await replace(path.join(profiles, 'richi-weidweg-v1.brf'), original);
await replace(path.join(profiles, 'richi-surface-v4.brf'), original
  .replace('assign richiroute_weidweg_push = true', 'assign richiroute_local_rules = false')
  .replace('assign weidweg_ramp = ramp:bicycle=yes', 'assign richiroute_guard = ramp:bicycle=yes'));
if (!process.env.ROUTING_RULES_CONFIG && !process.env.ROUTING_RULES_OUTPUT) {
  await replace(path.join(root, 'src/config/routing-rules.generated.json'), JSON.stringify(compiled.client, null, 2) + '\n');
}
await replace(path.join(output, 'manifest.json'), JSON.stringify({ revision: compiled.revision, ruleIds: active.map(r => r.id), reviewedTiles: Object.fromEntries(reviewed) }, null, 2) + '\n');
console.log(`Prepared ${active.length} local routing rules (${compiled.revision.slice(0, 12)}). Restart the routing service to activate them; no Java rebuild is needed.`);

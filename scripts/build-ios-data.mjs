// Lays out the iPhone app's data (outside git), as links to the computer's files:
//   ios/Routing/profiles/, rules.tsv, surfaces.tsv   in the app bundle, as the local engine uses them (start-local.sh)
//   ios/Routing/preferences.tsv     with --personal: the rider's own road preferences, for test builds on the rider's phone,
//                                   never in a build for others
//   ios/Routing/parameters.json     the profile and search parameters the planner sends, and their version for saved legs
//   ios/Data/segments/*.rd5         the routing data, and
//   ios/Data/Areas/<id>/map.pmtiles, terrain.pmtiles, search.index   offline areas (scripts/build-offline-packages.mjs): copied once
//                                   into the app's data container, where they stay from one install to the next
//   node scripts/build-ios-data.mjs [--areas at-6,at-7] [--personal]
// Copy it to the Mac with links followed (rsync -L).
import { mkdir, readdir, rm, symlink, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { routingProfile, routingParameters, routingPolicyVersion } from '../src/config/routing-policy.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, 'ios/Routing'), data = path.join(root, 'ios/Data'), areas = path.join(data, 'Areas');
const option = process.argv.indexOf('--areas');
const areaIds = option > 0 ? process.argv[option + 1]?.split(',').filter(Boolean) : ['at-6', 'at-7'];
if (!areaIds?.length) throw new Error('--areas needs area ids, e.g. --areas at-6,at-7');
const packages = path.join(root, '.cache/offline/packages/areas');
const rules = path.join(root, 'experiments/routing/.local/local-routing-rules');
const segments = path.join(root, '../richiroute-ubuntu-benchmark/data');
const preferences = path.join(root, '.cache/strava/preferences/rider.tsv');
const exists = file => access(file).then(() => true, () => false);

await Promise.all([target, data, path.join(root, 'ios/Areas')].map(folder => rm(folder, { recursive: true, force: true })));
await mkdir(target);
await mkdir(path.join(data, 'segments'), { recursive: true });
for (const file of (await readdir(segments)).filter(name => name.endsWith('.rd5'))) {
  await symlink(path.join(segments, file), path.join(data, 'segments', file));
}
await symlink(path.join(rules, 'profiles'), path.join(target, 'profiles'));
await symlink(path.join(rules, 'rules.tsv'), path.join(target, 'rules.tsv'));
if (await exists(path.join(rules, 'surfaces.tsv'))) await symlink(path.join(rules, 'surfaces.tsv'), path.join(target, 'surfaces.tsv'));
if (process.argv.includes('--personal')) {
  if (!await exists(preferences)) throw new Error(`--personal: no road preferences prepared at ${preferences}`);
  await symlink(preferences, path.join(target, 'preferences.tsv'));
}
await writeFile(path.join(target, 'parameters.json'), JSON.stringify({ profile: routingProfile, parameters: routingParameters, routingPolicy: routingPolicyVersion }, null, 1));
for (const id of areaIds) {
  await mkdir(path.join(areas, id), { recursive: true });
  for (const file of ['map.pmtiles', 'terrain.pmtiles', 'search.index']) await symlink(path.join(packages, id, file), path.join(areas, id, file));
}
console.log(`ios/Routing and ios/Data laid out from ${segments}, ${rules} and ${packages}`);

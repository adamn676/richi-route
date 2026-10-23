import thalPreference from '../../src/config/thal-preference.json' with { type: 'json' };
import routingSearch from '../../src/config/routing-search.json' with { type: 'json' };
import localRules from '../../src/config/routing-rules.generated.json' with { type: 'json' };
import { localRulesProfile } from '../../scripts/routing-profile.mjs';

export const profileSettings = {
  'local-rules-v1': {
    label: 'BRouter with shared local rules and optimized search; GraphHopper baseline',
    brouterProfile: localRules.profile,
    brouterParameters: { ...routingSearch, ...localRules.parameters },
  },
  baseline: { label: 'Baseline profiles', brouterProfile: 'richi-road' },
  'cyclepath-v1': { label: 'BRouter cycle-path candidate; GraphHopper baseline', brouterProfile: 'richi-cyclepath-v1' },
  'network-v2': { label: 'BRouter network v2 candidate; GraphHopper baseline', brouterProfile: 'richi-network-v2' },
  'traffic-v3': { label: 'BRouter traffic v3 candidate; GraphHopper baseline', brouterProfile: 'richi-traffic-v3' },
  'surface-v4': { label: 'BRouter surface v4 candidate; GraphHopper baseline', brouterProfile: 'richi-surface-v4' },
  'thal-local-v1': {
    label: 'BRouter surface v4 + accepted local Thal preference; GraphHopper baseline',
    brouterProfile: 'richi-surface-v4',
    brouterNogos: thalPreference.nogos,
  },
  'weidweg-local-v1': {
    label: 'BRouter with accepted Thal preference and Weidweg push-through; GraphHopper baseline',
    brouterProfile: 'richi-weidweg-v1',
    brouterNogos: thalPreference.nogos,
  },
  'weidweg-search-v1': {
    label: 'BRouter Weidweg profile with conservative destination search; GraphHopper baseline',
    brouterProfile: 'richi-weidweg-v1',
    brouterNogos: thalPreference.nogos,
    brouterParameters: { pass2coefficient: 0.5 },
  },
  'weidweg-search-v2': {
    label: 'BRouter Weidweg profile with refined destination search; GraphHopper baseline',
    brouterProfile: 'richi-weidweg-v1',
    brouterNogos: thalPreference.nogos,
    brouterParameters: { pass2coefficient: 0.7 },
  },
  'weidweg-search-v3': {
    label: 'BRouter Weidweg profile with faster initial and refinement searches; GraphHopper baseline',
    brouterProfile: 'richi-weidweg-v1',
    brouterNogos: thalPreference.nogos,
    brouterParameters: routingSearch,
  },
};

export function settingsFor(name) {
  if (!Object.hasOwn(profileSettings, name)) throw new Error('Unknown engine settings.');
  return profileSettings[name];
}

export function cyclepathProfile(baseline) {
  let profile = baseline.replaceAll('\r\n', '\n');
  const changes = [
    [/assign consider_traffic\s+= 0\.1\b/, 'assign consider_traffic = 0.5'],
    [/switch\s+highway=cycleway\s+1\.3\b/, 'switch highway=cycleway                          1.1'],
    [
      '       switch bikeaccess\n              0\n              switch footaccess\n                     300',
      // Crossing-node bicycle restrictions can describe crossing the road rather than riding along it.
      '       switch and highway=crossing and bicycle=no footaccess 60\n       switch bikeaccess\n              0\n              switch footaccess\n                     300',
    ],
  ];
  for (const [pattern, replacement] of changes) {
    const changed = profile.replace(pattern, replacement);
    if (changed === profile) throw new Error('Baseline BRouter profile changed; review candidate settings before rebuilding.');
    profile = changed;
  }
  return '# RichiRoute cyclepath-v1: experimental tuning profile, not rider-approved.\n' + profile;
}

export function candidateProfile(baseline, settings) {
  settingsFor(settings);
  if (settings === 'local-rules-v1') return localRulesProfile(candidateProfile(baseline, 'weidweg-local-v1'), localRules.retainedTags);
  if (['weidweg-search-v1', 'weidweg-search-v2', 'weidweg-search-v3'].includes(settings)) return candidateProfile(baseline, 'weidweg-local-v1');
  if (settings === 'thal-local-v1') return candidateProfile(baseline, 'surface-v4');
  if (settings === 'weidweg-local-v1') return candidateProfile(baseline, 'surface-v4')
    .replace('# RichiRoute surface-v4:', '# RichiRoute weidweg-local-v1:')
    .replace('---context:way', 'assign richiroute_weidweg_push = true\n\n---context:way')
    .replace('assign surfacepenalty', '# Retain ramp tags for the local engine guard; this does not grant access.\nassign weidweg_ramp = ramp:bicycle=yes\n\nassign surfacepenalty');
  const profile = cyclepathProfile(baseline);
  if (settings === 'cyclepath-v1') return profile;
  const network = profile
    .replace('# RichiRoute cyclepath-v1:', '# RichiRoute network-v2:')
    .replace('  add trafficpenalty', '  add switch and highway=cycleway not any_cycleroute 1.5 0\n  add trafficpenalty');
  if (settings === 'network-v2') return network;
  const traffic = network
    .replace('# RichiRoute network-v2:', '# RichiRoute traffic-v3:')
    .replace('assign consider_traffic = 0.5', 'assign consider_traffic = 2')
    .replace('bicycle=no footaccess 60', 'bicycle=no footaccess 20');
  if (settings === 'traffic-v3') return traffic;
  if (settings === 'surface-v4') return traffic
    .replace('# RichiRoute traffic-v3:', '# RichiRoute surface-v4:')
    .replace('assign costfactor', 'assign surfacepenalty = switch surface=unpaved|gravel|ground|dirt|grass|compacted|sand|pebblestone|fine_gravel|earth|mud|clay|rock 3 0\n\nassign costfactor')
    // Keep the existing dismount/access cost when it already exceeds the surface cost.
    .replace('add max onewaypenalty accesspenalty', 'add max onewaypenalty max accesspenalty surfacepenalty');
  throw new Error('Baseline settings do not require a candidate profile.');
}

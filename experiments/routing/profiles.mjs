import thalPreference from '../../src/config/thal-preference.json' with { type: 'json' };

export const profileSettings = {
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
  if (settings === 'thal-local-v1') return candidateProfile(baseline, 'surface-v4');
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

export function localRulesProfile(original, retainedTags) {
  let profile = original;
  for (const [before, after] of [
    ['# RichiRoute weidweg-local-v1:', '# RichiRoute configurable local rules:'],
    ['assign richiroute_weidweg_push = true', 'assign richiroute_local_rules = true'],
    ['assign weidweg_ramp = ramp:bicycle=yes', retainedTags.map((tag, i) => `assign richiroute_guard_${i} = ${tag}=`).join('\n')],
  ]) {
    if (!profile.includes(before)) throw new Error('Prepared base profile changed; review the local-rules profile derivation.');
    profile = profile.replace(before, after);
  }
  return profile;
}

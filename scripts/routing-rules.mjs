import { createHash } from 'node:crypto';

const token = /^[a-zA-Z0-9_:.-]+$/;
const kinds = new Set(['passage', 'turn', 'avoidance']);
const common = ['id', 'kind', 'enabled', 'mode', 'reviewedOn', 'reason', 'reviewedTiles', 'osmWays', 'osmRelation', 'reviewRunId'];
const fields = {
  passage: ['direction', 'segments', 'requiredTags', 'forbiddenTags', 'absentTags', 'originalCostfactor', 'costfactor', 'notice'],
  turn: ['from', 'via', 'to', 'restriction'],
  avoidance: ['center', 'radiusMeters', 'weight'],
};
const fail = message => { throw new Error(`Routing rules: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const encodedCoord = ([lon, lat]) => [Math.round(lon * 1e6) + 180000000, Math.round(lat * 1e6) + 90000000];
const coord = value => Array.isArray(value) && value.length === 2 && value.every(finite)
  && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90
  && value.every(n => Math.abs(n * 1e6 - Math.round(n * 1e6)) < 0.00001);
const key = pair => pair.map(c => encodedCoord(c).join(',')).join('/');
function tileFor([lon, lat]) {
  const x = Math.floor(Math.min(lon, 179.999999) / 5) * 5;
  const y = Math.floor(Math.min(lat, 89.999999) / 5) * 5;
  return `${x < 0 ? 'W' : 'E'}${Math.abs(x)}_${y < 0 ? 'S' : 'N'}${Math.abs(y)}.rd5`;
}

export function validateRules(data) {
  if (!object(data) || data.schemaVersion !== 1 || !Array.isArray(data.rules)
    || Object.keys(data).some(k => !['schemaVersion', 'rules'].includes(k))) fail('unsupported document');
  const ids = new Set(), segments = new Map(), turns = new Map(), tiles = new Map();
  for (const rule of data.rules) {
    if (!object(rule) || typeof rule.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule.id) || ids.has(rule.id)) fail('invalid or duplicate rule ID');
    ids.add(rule.id);
    const error = message => fail(`${rule.id}: ${message}`);
    if (!kinds.has(rule.kind) || rule.mode !== 'bicycle' || typeof rule.enabled !== 'boolean') error('unsupported kind, mode or enabled flag');
    const allowed = new Set([...common, ...fields[rule.kind]]);
    if (Object.keys(rule).some(k => !allowed.has(k))) error('unknown field');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rule.reviewedOn) || typeof rule.reason !== 'string' || !rule.reason.trim()) error('review date and reason are required');
    if (!object(rule.reviewedTiles) || !Object.keys(rule.reviewedTiles).length) error('reviewed tile checksums are required');
    for (const [tile, hash] of Object.entries(rule.reviewedTiles)) {
      if (!/^[EW]\d+_[NS]\d+\.rd5$/.test(tile) || !/^[a-f0-9]{64}$/.test(hash)) error('invalid tile or checksum');
      if (rule.enabled && tiles.has(tile) && tiles.get(tile) !== hash) error(`conflicting reviewed version of ${tile}`);
      if (rule.enabled) tiles.set(tile, hash);
    }
    if (rule.kind === 'passage') {
      if (!['forward', 'both'].includes(rule.direction) || !Array.isArray(rule.segments) || !rule.segments.length) error('segments and direction are required');
      // At least 1, as every way in the profile: the search's refinement relies on no way costing less than its length.
      if (rule.originalCostfactor !== 9999 || !finite(rule.costfactor) || rule.costfactor < 1 || rule.costfactor >= 9999) error('invalid passage cost');
      if (typeof rule.notice !== 'string' || !rule.notice.trim() || rule.notice.length > 500) error('a passage notice is required');
      if (!object(rule.requiredTags) || !Object.keys(rule.requiredTags).length || !object(rule.forbiddenTags) || !Array.isArray(rule.absentTags)) error('tag guards are required');
      for (const [tag, value] of Object.entries(rule.requiredTags)) {
        if (!token.test(tag) || typeof value !== 'string' || !token.test(value)) error('invalid required tag');
      }
      for (const [tag, values] of Object.entries(rule.forbiddenTags)) {
        if (!token.test(tag) || !Array.isArray(values) || !values.length || values.some(v => typeof v !== 'string' || !token.test(v))) error('invalid forbidden tag');
      }
      if (rule.absentTags.some(t => typeof t !== 'string' || !token.test(t)) || new Set(rule.absentTags).size !== rule.absentTags.length) error('invalid absent tag');
      for (const tag of Object.keys(rule.requiredTags)) {
        if (rule.absentTags.includes(tag) || rule.forbiddenTags[tag]?.includes(rule.requiredTags[tag])) error(`contradictory guard for ${tag}`);
      }
      for (const segment of rule.segments) {
        if (!Array.isArray(segment) || segment.length !== 2 || !segment.every(coord) || key([segment[0]]) === key([segment[1]])) error('invalid segment coordinates');
        for (const pair of rule.direction === 'both' ? [segment, [...segment].reverse()] : [segment]) {
          if (rule.enabled && segments.has(key(pair))) error(`segment conflicts with ${segments.get(key(pair))}`);
          if (rule.enabled) segments.set(key(pair), rule.id);
        }
      }
    } else if (rule.kind === 'turn') {
      if (![rule.from, rule.via, rule.to].every(coord) || rule.restriction !== 'prohibited'
        || new Set([rule.from, rule.via, rule.to].map(c => key([c]))).size !== 3) error('invalid directed turn');
      const turn = key([rule.from, rule.via, rule.to]);
      if (rule.enabled && turns.has(turn)) error(`turn conflicts with ${turns.get(turn)}`);
      if (rule.enabled) turns.set(turn, rule.id);
    } else if (!coord(rule.center) || !finite(rule.radiusMeters) || rule.radiusMeters <= 0 || rule.radiusMeters > 10000
      || !finite(rule.weight) || rule.weight <= 0) error('invalid avoidance circle or penalty');
    const locations = rule.kind === 'passage' ? rule.segments.flat() : rule.kind === 'turn' ? [rule.from, rule.via, rule.to] : [rule.center];
    for (const location of locations) if (!Object.hasOwn(rule.reviewedTiles, tileFor(location))) error(`missing reviewed checksum for ${tileFor(location)}`);
  }
  return data;
}

export function validateLookupTags(data, lookups) {
  const tags = new Map();
  let way = false;
  for (const line of lookups.split(/\r?\n/)) {
    if (line.startsWith('---context:')) way = line === '---context:way';
    if (!way || !line || line.startsWith('#') || line.startsWith('---')) continue;
    const [field, value] = line.trim().split(/\s+/), tag = field.split(';')[0];
    if (!tags.has(tag)) tags.set(tag, new Set());
    if (value) tags.get(tag).add(value);
  }
  for (const rule of data.rules.filter(r => r.enabled && r.kind === 'passage')) {
    for (const tag of [...Object.keys(rule.requiredTags), ...Object.keys(rule.forbiddenTags), ...rule.absentTags]) {
      if (!tags.has(tag)) fail(`${rule.id}: ${tag} is not available in the routing-data lookup table`);
    }
    for (const [tag, values] of [...Object.entries(rule.requiredTags).map(([tag, value]) => [tag, [value]]), ...Object.entries(rule.forbiddenTags)]) {
      for (const value of values) if (!tags.get(tag).has(value)) fail(`${rule.id}: use an encoded primary value for ${tag}=${value}`);
    }
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
}

export function compileRules(input) {
  const data = validateRules(input);
  const revision = createHash('sha256').update(JSON.stringify(canonical(data))).digest('hex');
  const rows = [['richiroute-rules', '1', revision]];
  const notices = [], retainedTags = new Set();
  for (const rule of data.rules.filter(r => r.enabled)) {
    if (rule.kind === 'passage') {
      const required = Object.entries(rule.requiredTags).sort().map(([k, v]) => `${k}=${v}`).join(';');
      const forbidden = Object.entries(rule.forbiddenTags).sort().flatMap(([k, values]) => [...values].sort().map(v => `${k}=${v}`)).join(';');
      const absent = [...rule.absentTags].sort().join(';');
      for (const tag of [...Object.keys(rule.requiredTags), ...Object.keys(rule.forbiddenTags), ...rule.absentTags]) retainedTags.add(tag);
      rows.push(['guard', rule.id, required, forbidden, absent, rule.costfactor]);
      for (const segment of rule.segments) {
        for (const pair of rule.direction === 'both' ? [segment, [...segment].reverse()] : [segment]) {
          rows.push(['segment', rule.id, ...pair.flatMap(encodedCoord)]);
        }
      }
      notices.push({ id: rule.id, text: rule.notice, direction: rule.direction, segments: rule.segments });
    } else if (rule.kind === 'turn') {
      rows.push(['turn', rule.id, ...[rule.via, rule.from, rule.to].flatMap(encodedCoord)]);
    } else {
      rows.push(['avoidance', rule.id, ...encodedCoord(rule.center), rule.radiusMeters, rule.weight]);
    }
  }
  const parameters = Object.fromEntries(Array.from({ length: 4 }, (_, i) =>
    [`richiroute_rules_${i}`, BigInt('0x' + revision.slice(i * 16, i * 16 + 16)).toString()]));
  return { revision, engine: rows.map(row => row.join('\t')).join('\n') + '\n',
    client: { schemaVersion: 1, profile: 'richi-local-v1', revision, parameters, notices, retainedTags: [...retainedTags].sort() }, retainedTags: [...retainedTags].sort() };
}

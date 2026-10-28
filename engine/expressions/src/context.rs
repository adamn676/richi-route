//! Port of `BExpressionContext` with its `CacheNode`/`VarWrapper` result cache and
//! `BExpressionLookupValue`, plus `BExpressionMetaData.readMetaData`.

use std::borrow::Cow;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::path::Path;
use std::rc::Rc;

use brouter_util::{BitCoderContext, BitWriter, Description, crc};

use crate::error::{ExpressionError, Failure};
use crate::expression::{self, Env, EvalError, Expr, ExprId, Parser};
use crate::java;
use crate::lru_map::LruMap;

/// Which tags a context reads. Java has one subclass per kind.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ContextKind {
    Way,
    Node,
}

const WAY_BUILD_IN_VARIABLES: [&str; 20] = [
    "costfactor",
    "turncost",
    "uphillcostfactor",
    "downhillcostfactor",
    "initialcost",
    "nodeaccessgranted",
    "initialclassifier",
    "trafficsourcedensity",
    "istrafficbackbone",
    "priorityclassifier",
    "classifiermask",
    "maxspeed",
    "uphillcost",
    "downhillcost",
    "uphillcutoff",
    "downhillcutoff",
    "uphillmaxslope",
    "downhillmaxslope",
    "uphillmaxslopecost",
    "downhillmaxslopecost",
];

const NODE_BUILD_IN_VARIABLES: [&str; 1] = ["initialcost"];

impl ContextKind {
    fn name(self) -> &'static str {
        match self {
            Self::Way => "way",
            Self::Node => "node",
        }
    }

    /// The variables the router reads after each evaluation (`getBuildInVariableNames`).
    fn build_in_variable_names(self) -> &'static [&'static str] {
        match self {
            Self::Way => &WAY_BUILD_IN_VARIABLES,
            Self::Node => &NODE_BUILD_IN_VARIABLES,
        }
    }
}

/// Versions from the lookup table's header (`BExpressionMetaData`); -1 when missing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MetaData {
    pub lookup_version: i16,
    pub lookup_minor_version: i16,
    pub min_app_version: i16,
}

impl Default for MetaData {
    fn default() -> Self {
        Self { lookup_version: -1, lookup_minor_version: -1, min_app_version: -1 }
    }
}

/// `BExpressionLookupValue`: a value with optional aliases. `number` is what `Float.parseFloat` makes
/// of the value (0 when it is no number), which Java recomputes on every `v:` read.
pub(crate) struct LookupValue {
    pub(crate) value: String,
    aliases: Vec<String>,
    pub(crate) number: f32,
}

impl LookupValue {
    fn new(value: &str) -> Self {
        Self { value: value.to_string(), aliases: Vec::new(), number: java::parse_float(value).unwrap_or(0.0) }
    }

    /// Compares the value and its aliases (`equals` compares the value only).
    fn matches(&self, s: &str) -> bool {
        self.value == s || self.aliases.iter().any(|alias| alias == s)
    }
}

/// `CacheNode`: a description and its results, both directions.
struct CacheEntry {
    ab: Description,
    vars: Rc<[f32]>,
}

/// The result cache of a context with a hash size above zero (Java's `cache`, `resultVarCache` and
/// their probe objects).
struct EvalCache {
    cache: LruMap<CacheEntry>,
    /// `VarWrapper`s: unifies equal result sets.
    result_var_cache: LruMap<Rc<[f32]>>,
    /// Filled on each miss; kept in the result set cache when its values are new.
    probe_vars: Option<Rc<[f32]>>,
    /// The copy `unify` made last. Java's decoder passes that very array to `accessType`, and a cache
    /// miss then stores the caller's array; keeping it lets later `unify` calls share it the same way.
    last_unified: Option<Description>,
    /// Cache nodes by the address of their description array, which the decoder's ways share. Java
    /// checks only the node `unify` found last by reference. A node whose array is the very one asked
    /// for is the only node with that content (a miss inserts only new content), so it is the node the
    /// CRC lookup would find.
    by_address: Box<[u32]>,
}

impl EvalCache {
    const BY_ADDRESS_BITS: u32 = 12;

    /// The node holding this very array, if it is the one remembered for its address.
    fn node_by_address(&self, ab: &[u8]) -> Option<u32> {
        let idx = self.by_address[address_slot(ab, 0, Self::BY_ADDRESS_BITS)];
        (idx != u32::MAX && same_slice(&self.cache.value(idx).ab, ab)).then_some(idx)
    }

    fn remember_address(&mut self, idx: u32, ab: &[u8]) {
        if same_slice(&self.cache.value(idx).ab, ab) {
            self.by_address[address_slot(ab, 0, Self::BY_ADDRESS_BITS)] = idx;
        }
    }
}

/// A slot of a table with `2^bits` entries for the address of `ab`, mixed with `salt`.
fn address_slot(ab: &[u8], salt: u64, bits: u32) -> usize {
    let hash = (ab.as_ptr() as usize as u64 ^ salt).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    (hash >> (64 - bits)) as usize
}

/// The results of a context without a result cache whose evaluation depends on the description alone
/// (`expression::depends_on_lookups_only`): the context's own variables after evaluating a description,
/// per direction. Evaluating that description again would give exactly these values, so a hit restores
/// them instead. Java has no cache here and evaluates every (node) description afresh.
struct ResultMemo {
    by_direction: [VariablesByDescription; 2],
    /// The entries found last, by the address of the description asked for, which saves the hashing
    /// when the decoder's nodes share their description arrays.
    by_address: Box<[Option<AddressedEntry>]>,
}

type VariablesByDescription = HashMap<Description, Rc<[f32]>, BuildHasherDefault<FxHasher>>;

struct AddressedEntry {
    inverse_direction: bool,
    ab: Description,
    vars: Rc<[f32]>,
}

impl Default for ResultMemo {
    fn default() -> Self {
        Self { by_direction: Default::default(), by_address: (0..1 << Self::BY_ADDRESS_BITS).map(|_| None).collect() }
    }
}

impl ResultMemo {
    /// More descriptions than a routing area has distinct node tag sets; beyond that, start over.
    const LIMIT: usize = 1 << 14;
    const BY_ADDRESS_BITS: u32 = 10;

    fn get(&mut self, inverse_direction: bool, ab: &[u8]) -> Option<&[f32]> {
        let slot = address_slot(ab, u64::from(inverse_direction), Self::BY_ADDRESS_BITS);
        // (the content decides; the address only finds the entry faster)
        let hit =
            self.by_address[slot].as_ref().is_some_and(|e| e.inverse_direction == inverse_direction && *e.ab == *ab);
        if !hit {
            let (ab, vars) = self.by_direction[usize::from(inverse_direction)].get_key_value(ab)?;
            let entry = AddressedEntry { inverse_direction, ab: Rc::clone(ab), vars: Rc::clone(vars) };
            self.by_address[slot] = Some(entry);
        }
        self.by_address[slot].as_ref().map(|e| &*e.vars)
    }

    fn insert(&mut self, inverse_direction: bool, ab: &[u8], vars: &[f32]) {
        let map = &mut self.by_direction[usize::from(inverse_direction)];
        if map.len() >= Self::LIMIT {
            map.clear();
            self.by_address.fill_with(|| None);
        }
        map.insert(ab.into(), vars.into());
    }
}

/// A fast hash for short byte strings (descriptions are a few bytes).
#[derive(Default)]
pub(crate) struct FxHasher(u64);

impl Hasher for FxHasher {
    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8) {
            let mut word = [0u8; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            self.write_u64(u64::from_le_bytes(word));
        }
    }

    fn write_u64(&mut self, v: u64) {
        self.0 = (self.0.rotate_left(5) ^ v).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }

    fn write_usize(&mut self, v: usize) {
        self.write_u64(v as u64);
    }

    fn finish(&self) -> u64 {
        // the table picks buckets by the low bits, which the multiplication fills from low bits only
        self.0.rotate_left(26)
    }
}

/// The state and code the way and node contexts share (`BExpressionContext`). Use it through
/// [`WayContext`](crate::WayContext) and [`NodeContext`](crate::NodeContext).
pub struct ExpressionContext {
    kind: ContextKind,
    /// The context whose profile section is parsed: the kind's name, or the read-only context
    /// (`global`) during the first pass.
    pub(crate) context: String,
    /// Not reset between passes, as in Java.
    pub(crate) in_our_context: bool,
    pub(crate) model_class: Option<String>,

    lookup_numbers: HashMap<String, usize>,
    pub(crate) lookup_values: Vec<Vec<LookupValue>>,
    lookup_names: Vec<String>,
    pub(crate) lookup_idx_used: Vec<bool>,
    lookup_data_frozen: bool,
    lookup_data: Vec<i32>,
    parsed_lines: i32,
    fix_tags_written: bool,
    pub(crate) meta: MetaData,

    pub(crate) variable_numbers: HashMap<String, usize>,
    pub(crate) last_assigned_expression: Vec<Option<ExprId>>,
    pub(crate) expression_node_count: i32,
    variable_data: Vec<f32>,
    pub(crate) exprs: Vec<Expr>,
    expression_list: Vec<ExprId>,
    pub(crate) min_write_idx: usize,

    /// Variable index of each build-in (output) variable, -1 if the profile does not assign it.
    build_in_variable_idx: Vec<i32>,
    current_vars: Option<Rc<[f32]>>,
    current_var_offset: usize,
    cache: Option<Box<EvalCache>>,
    memo: Option<Box<ResultMemo>>,
    /// See `depends_on_description_only`.
    description_only: bool,

    pub(crate) no_start_ways: Vec<(usize, i32)>,
    pub(crate) linenr: i32,
}

impl ExpressionContext {
    /// `hash_size` is the result cache's capacity; 0 evaluates every description afresh.
    pub(crate) fn new(kind: ContextKind, hash_size: usize) -> Self {
        let cache = (hash_size > 0).then(|| {
            let size = i32::try_from(hash_size).expect("hash size fits an int");
            Box::new(EvalCache {
                cache: LruMap::new(4 * size, size),
                result_var_cache: LruMap::new(4096, 4096),
                probe_vars: None,
                last_unified: None,
                by_address: vec![u32::MAX; 1 << EvalCache::BY_ADDRESS_BITS].into(),
            })
        });
        Self {
            kind,
            context: kind.name().to_string(),
            in_our_context: false,
            model_class: None,
            lookup_numbers: HashMap::new(),
            lookup_values: Vec::new(),
            lookup_names: Vec::new(),
            lookup_idx_used: Vec::new(),
            lookup_data_frozen: false,
            lookup_data: Vec::new(),
            parsed_lines: 0,
            fix_tags_written: false,
            meta: MetaData::default(),
            variable_numbers: HashMap::new(),
            last_assigned_expression: Vec::new(),
            expression_node_count: 0,
            variable_data: Vec::new(),
            exprs: Vec::new(),
            expression_list: Vec::new(),
            min_write_idx: 0,
            build_in_variable_idx: Vec::new(),
            current_vars: None,
            current_var_offset: 0,
            cache,
            memo: None,
            description_only: false,
            no_start_ways: Vec::new(),
            linenr: 0,
        }
    }

    pub fn meta(&self) -> MetaData {
        self.meta
    }

    // ---- lookup table ----

    fn parse_meta_line(&mut self, line: &str) -> Result<(), Failure> {
        self.parsed_lines += 1;
        let mut tokens = line.split(' ').filter(|t| !t.is_empty());
        let no_element = || Failure::new("java.util.NoSuchElementException", "");
        let mut name = tokens.next().ok_or_else(no_element)?;
        let value = tokens.next().ok_or_else(no_element)?;
        if let Some(idx) = name.find(';') {
            name = &name[..idx];
        }
        if !self.fix_tags_written {
            self.fix_tags_written = true;
            match self.kind {
                ContextKind::Way => self.add_lookup_value("reversedirection", "yes"),
                ContextKind::Node => self.add_lookup_value("nodeaccessgranted", "yes"),
            };
        }
        if name == "reversedirection" || name == "nodeaccessgranted" {
            return Ok(()); // these are hardcoded
        }
        if let Some(new_value) = self.add_lookup_value(name, value) {
            new_value.aliases.extend(tokens.map(str::to_string));
        }
        Ok(())
    }

    fn finish_meta_parsing(&mut self) -> Result<(), Failure> {
        if self.parsed_lines == 0 && self.context != "global" {
            return Err(Failure::illegal_argument(format!(
                "lookup table does not contain data for context {} (old version?)",
                self.context
            )));
        }
        self.lookup_data_frozen = true;
        self.lookup_idx_used = vec![false; self.lookup_values.len()];
        Ok(())
    }

    /// `addLookupValue(name, value, null)`: adds the name and value if they are new and records the
    /// value in the context's lookup data. Returns a newly created value, for its aliases.
    fn add_lookup_value(&mut self, name: &str, value: &str) -> Option<&mut LookupValue> {
        let num = match self.lookup_numbers.get(name) {
            Some(&num) => num,
            None => {
                let num = self.lookup_values.len();
                self.lookup_numbers.insert(name.to_string(), num);
                self.lookup_names.push(name.to_string());
                self.lookup_values.push(vec![LookupValue::new(""), LookupValue::new("unknown")]);
                self.lookup_data.push(0);
                num
            }
        };
        let values = &self.lookup_values[num];
        let i = values.iter().position(|v| v.matches(value)).unwrap_or(values.len());
        let is_new = i == values.len();
        if is_new {
            if i == 500 {
                return None; // value limit reached
            }
            self.lookup_values[num].push(LookupValue::new(value));
        }
        self.lookup_data[num] = i as i32;
        is_new.then(|| &mut self.lookup_values[num][i])
    }

    /// `getLookupNameIdx`; also `getLookupKey`. -1 for unknown names.
    pub fn lookup_key(&self, name: &str) -> i32 {
        self.lookup_numbers.get(name).map_or(-1, |&num| num as i32)
    }

    /// The value's index, matching the primary value only; -1 if missing.
    pub(crate) fn get_lookup_value_idx(&self, name_idx: usize, value: &str) -> i32 {
        self.lookup_values[name_idx].iter().position(|v| v.value == value).map_or(-1, |i| i as i32)
    }

    pub fn lookup_names(&self) -> &[String] {
        &self.lookup_names
    }

    /// Number of values of a lookup key, including the empty value 0 and `unknown` 1.
    pub fn lookup_value_count(&self, name_idx: usize) -> usize {
        self.lookup_values[name_idx].len()
    }

    pub fn lookup_value_name(&self, name_idx: usize, value_idx: usize) -> &str {
        &self.lookup_values[name_idx][value_idx].value
    }

    /// The aliases the lookup table lists after a value.
    pub fn lookup_value_aliases(&self, name_idx: usize, value_idx: usize) -> &[String] {
        &self.lookup_values[name_idx][value_idx].aliases
    }

    /// `createNewLookupData`: a zeroed lookup array, once the lookup table is read.
    pub fn create_new_lookup_data(&self) -> Option<Vec<i32>> {
        self.lookup_data_frozen.then(|| vec![0; self.lookup_values.len()])
    }

    pub fn is_lookup_idx_used(&self, idx: usize) -> bool {
        self.lookup_idx_used.get(idx).copied().unwrap_or(false)
    }

    pub fn set_all_tags_used(&mut self) {
        self.lookup_idx_used.fill(true);
    }

    // ---- descriptions ----

    /// `encode(int[])`: the description of a lookup array, `None` when no tag is set. Values must be
    /// valid indices (or 1000 and above for numbers). Map creation's job, here for tests and tools.
    pub fn encode(&self, ld: &[i32]) -> Option<Vec<u8>> {
        let mut writer = BitWriter::new();
        let (mut skipped_tags, mut non_null_tags) = (0, 0);
        // skip the first value (the hardwired reversedirection/nodeaccessgranted)
        for &d in &ld[1..self.lookup_values.len()] {
            if d == 0 {
                skipped_tags += 1;
                continue;
            }
            writer.encode_var_bits(skipped_tags + 1);
            non_null_tags += 1;
            skipped_tags = 0;
            // 0 is excluded already, 1 (unknown) rotates up to 8 to leave the short codes to the
            // popular values
            writer.encode_var_bits(if d < 2 {
                7
            } else if d < 9 {
                d - 2
            } else {
                d - 1
            });
        }
        writer.encode_var_bits(0);
        (non_null_tags > 0).then(|| writer.finish())
    }

    /// `decode(int[], boolean, byte[])`: decodes a description into a lookup array. Value 0 is the
    /// hardwired first tag (`reversedirection` or `nodeaccessgranted`).
    pub fn decode_into(&self, ld: &mut [i32], inverse_direction: bool, ab: &[u8]) {
        decode(&self.lookup_values, ld, inverse_direction, ab);
    }

    /// `decode(byte[])`: decodes into the context's own lookup data, which [`Self::lookup_value`]
    /// reads.
    pub fn decode(&mut self, ab: &[u8]) {
        decode(&self.lookup_values, &mut self.lookup_data, false, ab);
    }

    /// `getLookupValue(int)`: the number behind the current value of a lookup key (NaN when unset),
    /// as the last `decode` or evaluation that ran left it.
    pub fn lookup_value(&self, key: usize) -> f32 {
        let env = Env { lookup_data: &self.lookup_data, lookup_values: &self.lookup_values, foreign: None };
        expression::lookup_value(&env, key as i32).expect("valid lookup key")
    }

    /// `getKeyValueDescription`: `name=value` pairs of the set tags, as route messages show them.
    /// Java decodes into the context's lookup data; nothing reads that afterwards before the next
    /// decode, so a scratch array is equivalent.
    pub fn key_value_description(&self, inverse_direction: bool, ab: &[u8]) -> String {
        let mut ld = vec![0; self.lookup_values.len()];
        decode(&self.lookup_values, &mut ld, inverse_direction, ab);
        let mut sb = String::with_capacity(200);
        for ((name, values), &val) in self.lookup_names.iter().zip(&self.lookup_values).zip(&ld) {
            let value: Cow<str> = if val >= 1000 {
                java::float_to_string((val - 1000) as f32 / 100.0).into()
            } else {
                values[val as usize].value.as_str().into()
            };
            if !value.is_empty() {
                if !sb.is_empty() {
                    sb.push(' ');
                }
                sb.push_str(name);
                sb.push('=');
                sb.push_str(&value);
            }
        }
        sb
    }

    /// `checkStartWay`: false for descriptions with a tag the profile's `noStartWay` comment lists.
    pub fn check_start_way(&self, ab: &[u8]) -> bool {
        if self.no_start_ways.is_empty() {
            return true; // decoding has no other effect
        }
        // Java decodes into 512 values; keys past the table are never set in the descriptions the
        // decoder builds (it drops unused keys), so the table's size gives the same values.
        let mut ld2 = vec![0; self.lookup_values.len()];
        decode(&self.lookup_values, &mut ld2, false, ab);
        !self.no_start_ways.iter().any(|&(key, value)| ld2[key] == value)
    }

    /// The (lookup key, value index) pairs of the `noStartWay` comment.
    pub fn no_start_ways(&self) -> &[(usize, i32)] {
        &self.no_start_ways
    }

    /// `freeNoWays`.
    pub fn free_no_ways(&mut self) {
        self.no_start_ways.clear();
    }

    /// `unify` (`IByteArrayUnifier`): the cached description with these bytes if the cache holds one
    /// under their CRC, else a new copy.
    pub fn unify(&mut self, ab: &[u8], offset: usize, len: usize) -> Description {
        let bytes = &ab[offset..offset + len];
        // Java has no cache to look in for hash size 0 and throws; only the way context unifies.
        let Some(cache) = self.cache.as_deref_mut() else {
            return Rc::from(bytes);
        };
        // crc based cache lookup only
        if let Some(idx) = cache.cache.get(crc(ab, offset, len), |_| true)
            && *cache.cache.value(idx).ab == *bytes
        {
            let unified = Rc::clone(&cache.cache.value(idx).ab);
            cache.remember_address(idx, &unified); // the decoder evaluates it next (Java: lastCacheNode)
            return unified;
        }
        let copy: Description = Rc::from(bytes);
        cache.last_unified = Some(Rc::clone(&copy));
        copy
    }

    // ---- profile ----

    /// `parseFile(file, "global", keyValues)`: parses the read-only `global` section first, with the
    /// injected key values, then the context's own section. `foreign` is the way context when parsing
    /// a node context.
    pub(crate) fn parse_file(
        &mut self,
        file: &Path,
        key_values: &[(String, String)],
        foreign: Option<&mut ExpressionContext>,
    ) -> Result<(), ExpressionError> {
        let file_name = file.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        if !file.exists() {
            return Err(ExpressionError(format!("profile {file_name} does not exist")));
        }
        match self.parse_passes(file, key_values, foreign) {
            Ok(()) => {}
            Err(failure) if failure.is_illegal_argument() => {
                let message = failure.message().0;
                return Err(ExpressionError(format!("ParseException {file_name} at line {}: {message}", self.linenr)));
            }
            Err(failure) => return Err(failure.wrapped()),
        }
        if self.expression_list.is_empty() {
            return Err(ExpressionError(format!(
                "{file_name} does not contain expressions for context {} (old version?)",
                self.context
            )));
        }
        Ok(())
    }

    fn parse_passes(
        &mut self,
        file: &Path,
        key_values: &[(String, String)],
        mut foreign: Option<&mut ExpressionContext>,
    ) -> Result<(), Failure> {
        // Java reads the file once per pass; reading it once is the same.
        let text = read_text(file)?;
        self.linenr = 1;
        let real_context = std::mem::replace(&mut self.context, "global".to_string());
        self.expression_list = Parser::new(self, foreign.as_deref_mut(), &text).parse_all(key_values)?;
        self.variable_data = vec![0.0; self.variable_numbers.len()];
        // the lookup data is a dummy here: evaluate just to create the variables
        let foreign_values = foreign.as_deref().and_then(ExpressionContext::current_build_in_values);
        self.evaluate_expressions(foreign_values)?;
        self.context = real_context;

        self.linenr = 1;
        self.min_write_idx = self.variable_data.len();
        self.expression_list = Parser::new(self, foreign, &text).parse_all(&[])?;
        self.last_assigned_expression = Vec::new();

        // determine the build-in variable indices
        self.build_in_variable_idx =
            self.kind.build_in_variable_names().iter().map(|name| self.variable_idx(name)).collect();
        let mut variable_data = vec![0.0; self.variable_numbers.len()];
        variable_data[..self.min_write_idx].copy_from_slice(&self.variable_data[..self.min_write_idx]);
        self.variable_data = variable_data;
        self.description_only = expression::depends_on_lookups_only(
            &self.exprs,
            &self.expression_list,
            self.variable_data.len(),
            self.min_write_idx,
        );
        self.memo = (self.cache.is_none() && self.description_only).then(Box::default);
        Ok(())
    }

    /// Whether an evaluation's results depend on the description and direction alone: the section
    /// reads no foreign (`way:`) variable and none of its own variables before assigning it. Then
    /// neither the evaluation order nor the result cache's contents can change a value.
    pub fn depends_on_description_only(&self) -> bool {
        self.description_only
    }

    /// `getVariableIdx(name, false)`: -1 for unknown variables.
    pub(crate) fn variable_idx(&self, name: &str) -> i32 {
        self.variable_numbers.get(name).map_or(-1, |&num| num as i32)
    }

    /// `getVariableIdx(name, true)`: creates a missing variable.
    pub(crate) fn create_variable(&mut self, name: &str) -> usize {
        if let Some(&num) = self.variable_numbers.get(name) {
            return num;
        }
        let num = self.variable_numbers.len();
        self.variable_numbers.insert(name.to_string(), num);
        self.last_assigned_expression.push(None);
        num
    }

    /// `getVariableValue(name, default)`: the variable's current value. After parsing, the global
    /// variables hold the profile's settings, which is how the router reads them.
    pub fn variable_value(&self, name: &str, default_value: f32) -> f32 {
        self.variable_numbers.get(name).map_or(default_value, |&num| self.variable_data[num])
    }

    /// Every variable as (name, current value, read-only), sorted by name. Read-only variables come
    /// from the global context. For tools and diagnostics.
    pub fn variables(&self) -> Vec<(&str, f32, bool)> {
        let mut variables: Vec<_> = self
            .variable_numbers
            .iter()
            .map(|(name, &num)| (name.as_str(), self.variable_data[num], num < self.min_write_idx))
            .collect();
        variables.sort_unstable_by(|a, b| a.0.cmp(b.0));
        variables
    }

    /// `_modelClass`: the `---model:` class of the profile, if any.
    pub fn model_class(&self) -> Option<&str> {
        self.model_class.as_deref()
    }

    /// Number of expression nodes after folding (`expressionNodeCount`).
    pub fn expression_node_count(&self) -> i32 {
        self.expression_node_count
    }

    /// Number of top-level expressions of the context's own section.
    pub fn expression_count(&self) -> usize {
        self.expression_list.len()
    }

    // ---- output variables ----

    /// `getOutputVariableIndex`: registers a variable as an output (build-in) variable and returns its
    /// index for [`Self::build_in_variable`].
    ///
    /// # Panics
    /// When a new output is registered after the first evaluation: the cached results would lack it
    /// (Java fails or reads the wrong value then). BRouter registers all outputs while setting up.
    pub fn output_variable_index(&mut self, name: &str, must_exist: bool) -> Result<usize, ExpressionError> {
        self.register_output_variable(name, must_exist).map_err(Failure::message)
    }

    pub(crate) fn register_output_variable(&mut self, name: &str, must_exist: bool) -> Result<usize, Failure> {
        let idx = self.variable_idx(name);
        if idx < 0 {
            if must_exist {
                return Err(Failure::illegal_argument(format!("unknown variable: {name}")));
            }
        } else if (idx as usize) < self.min_write_idx {
            return Err(Failure::illegal_argument(format!("bad access to global variable: {name}")));
        }
        // An unknown name (-1) finds the first build-in variable the profile does not assign, as in Java.
        if let Some(i) = self.build_in_variable_idx.iter().position(|&b| b == idx) {
            return Ok(i);
        }
        assert!(self.current_vars.is_none(), "output variable {name} registered after the first evaluation");
        self.build_in_variable_idx.push(idx);
        Ok(self.build_in_variable_idx.len() - 1)
    }

    pub fn build_in_variable_count(&self) -> usize {
        self.build_in_variable_idx.len()
    }

    /// Whether the profile assigns the build-in variable (Java: its variable index is not -1).
    pub fn is_build_in_variable_defined(&self, idx: usize) -> bool {
        self.build_in_variable_idx[idx] >= 0
    }

    /// `getBuildInVariable`: an output of the last evaluation.
    ///
    /// # Panics
    /// Before the first evaluation (Java: `NullPointerException`).
    pub fn build_in_variable(&self, idx: usize) -> f32 {
        self.current_vars.as_ref().expect("evaluate before reading results")[idx + self.current_var_offset]
    }

    /// `setInverseVars`: read the reverse direction's results of the last cached evaluation.
    pub(crate) fn set_inverse_vars(&mut self) {
        self.current_var_offset = self.build_in_variable_idx.len();
    }

    /// The current outputs from the current offset, which a node context's `way:` variables read.
    pub(crate) fn current_build_in_values(&self) -> Option<&[f32]> {
        self.current_vars.as_deref().map(|vars| &vars[self.current_var_offset..])
    }

    // ---- evaluation ----

    /// `evaluate()`: runs every top-level expression.
    fn evaluate_expressions(&mut self, foreign: Option<&[f32]>) -> Result<(), EvalError> {
        let env = Env { lookup_data: &self.lookup_data, lookup_values: &self.lookup_values, foreign };
        for &id in &self.expression_list {
            expression::evaluate(&self.exprs, id, &mut self.variable_data, &env)?;
        }
        Ok(())
    }

    fn evaluate_into(&mut self, vars: &mut [f32], offset: usize, foreign: Option<&[f32]>) -> Result<(), EvalError> {
        self.evaluate_expressions(foreign)?;
        self.store_build_ins(vars, offset);
        Ok(())
    }

    fn store_build_ins(&self, vars: &mut [f32], offset: usize) {
        for (vi, &idx) in self.build_in_variable_idx.iter().enumerate() {
            vars[vi + offset] = if idx == -1 { 0.0 } else { self.variable_data[idx as usize] };
        }
    }

    /// `evaluate(boolean, byte[])`: evaluates a description. With a cache, both directions are
    /// computed on a miss and kept, keyed by the description bytes.
    pub(crate) fn evaluate_description(
        &mut self,
        inverse_direction: bool,
        ab: &[u8],
        foreign: Option<&[f32]>,
    ) -> Result<(), ExpressionError> {
        let mut cache = self.cache.take();
        let result = match cache.as_deref_mut() {
            Some(cache) => self.evaluate_cached(cache, inverse_direction, ab, foreign),
            None => self.evaluate_uncached(inverse_direction, ab, foreign),
        };
        self.cache = cache;
        result.map_err(|e| Failure::from(e).message())
    }

    fn evaluate_uncached(
        &mut self,
        inverse_direction: bool,
        ab: &[u8],
        foreign: Option<&[f32]>,
    ) -> Result<(), EvalError> {
        let n = self.build_in_variable_idx.len();
        // Java reuses the array; nothing else holds it in a context without a cache.
        let mut vars = self.current_vars.take().unwrap_or_else(|| zeros(n));
        let values = Rc::get_mut(&mut vars).expect("uniquely owned");
        let own = self.min_write_idx;
        let result = match self.memo.as_deref_mut().and_then(|memo| memo.get(inverse_direction, ab)) {
            // (the lookup data stays at an earlier description; only `decode` users read it)
            Some(memoized) => {
                self.variable_data[own..].copy_from_slice(memoized);
                self.store_build_ins(values, 0);
                Ok(())
            }
            None => {
                decode(&self.lookup_values, &mut self.lookup_data, inverse_direction, ab);
                let result = self.evaluate_into(values, 0, foreign);
                if let (Ok(()), Some(memo)) = (&result, self.memo.as_deref_mut()) {
                    memo.insert(inverse_direction, ab, &self.variable_data[own..]);
                }
                result
            }
        };
        self.current_vars = Some(vars);
        result?; // Java throws before resetting the offset
        self.current_var_offset = 0;
        Ok(())
    }

    fn evaluate_cached(
        &mut self,
        cache: &mut EvalCache,
        inverse_direction: bool,
        ab: &[u8],
        foreign: Option<&[f32]>,
    ) -> Result<(), EvalError> {
        let n = self.build_in_variable_idx.len();
        // Java compares the last unified node's array by reference first.
        let by_address = cache.node_by_address(ab);
        let hash = if by_address.is_some() { 0 } else { crc(ab, 0, ab.len()) };
        let found = by_address.or_else(|| cache.cache.get(hash, |entry| *entry.ab == *ab));

        let idx = match found {
            Some(idx) => {
                cache.cache.touch(idx);
                idx
            }
            None => {
                // Java takes and inserts the cache node before evaluating. Evaluating first changes
                // nothing on success (evaluation does not touch the cache) and keeps the cache
                // consistent when an evaluation fails.
                let mut probe = cache.probe_vars.take().unwrap_or_else(|| zeros(2 * n));
                let probe_values = Rc::get_mut(&mut probe).expect("the probe set is not shared");
                // forward direction
                decode(&self.lookup_values, &mut self.lookup_data, false, ab);
                self.evaluate_into(probe_values, 0, foreign)?;
                // inverse direction: reuse the decoding
                self.lookup_data[0] = 2;
                self.evaluate_into(probe_values, n, foreign)?;

                // unify the result variable set
                let vars_hash = arrays_hash_code(&probe);
                let vars = match cache.result_var_cache.get(vars_hash, |vars| floats_equal(vars, &probe)) {
                    Some(vw) => {
                        cache.probe_vars = Some(probe);
                        Rc::clone(cache.result_var_cache.value(vw))
                    }
                    None => {
                        cache.result_var_cache.insert(vars_hash, Rc::clone(&probe));
                        probe
                    }
                };
                let stored = match &cache.last_unified {
                    Some(unified) if same_slice(unified, ab) => Rc::clone(unified),
                    _ => Rc::from(ab),
                };
                cache.cache.insert(hash, CacheEntry { ab: stored, vars })
            }
        };
        if by_address.is_none() {
            cache.remember_address(idx, ab);
        }
        self.current_vars = Some(Rc::clone(&cache.cache.value(idx).vars));
        self.current_var_offset = if inverse_direction { n } else { 0 };
        Ok(())
    }
}

fn zeros(n: usize) -> Rc<[f32]> {
    std::iter::repeat_n(0.0, n).collect()
}

/// A text file as Java's `FileReader` reads it (UTF-8, malformed bytes replaced).
fn read_text(file: &Path) -> Result<String, Failure> {
    let bytes = std::fs::read(file).map_err(|e| {
        // Java gives the bare system message: "No such file or directory", without "(os error 2)"
        let reason = e.to_string();
        let reason = reason.split(" (os error").next().unwrap_or_default();
        Failure::new("java.io.FileNotFoundException", format!("{} ({reason})", file.display()))
    })?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Java's reference comparison of two arrays.
fn same_slice(a: &[u8], b: &[u8]) -> bool {
    std::ptr::eq(a.as_ptr(), b.as_ptr()) && a.len() == b.len()
}

/// `Float.floatToIntBits`: like `to_bits`, but every NaN is the canonical one.
fn float_to_int_bits(v: f32) -> i32 {
    if v.is_nan() { 0x7fc0_0000 } else { v.to_bits() as i32 }
}

/// `Arrays.hashCode(float[])`.
fn arrays_hash_code(values: &[f32]) -> i32 {
    values.iter().fold(1i32, |h, &v| h.wrapping_mul(31).wrapping_add(float_to_int_bits(v)))
}

/// `Arrays.equals(float[], float[])`.
fn floats_equal(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(&x, &y)| float_to_int_bits(x) == float_to_int_bits(y))
}

/// `BExpressionContext.decode(int[], boolean, byte[])`.
fn decode(lookup_values: &[Vec<LookupValue>], ld: &mut [i32], inverse_direction: bool, ab: &[u8]) {
    let mut ctx = BitCoderContext::new(ab);
    // start with the first value hardwired (reversedirection or nodeaccessgranted)
    ld[0] = if inverse_direction { 2 } else { 0 };
    let mut inum = 1usize;
    loop {
        let delta = ctx.decode_var_bits();
        if delta == 0 {
            break;
        }
        if inum as i64 + i64::from(delta) > ld.len() as i64 {
            break; // a higher minor version is ok
        }
        for _ in 1..delta {
            ld[inum] = 0;
            inum += 1;
        }
        // see the encoder for the value rotation
        let dd = ctx.decode_var_bits();
        let mut d = if dd == 7 {
            1
        } else if dd < 7 {
            dd + 2
        } else {
            dd.wrapping_add(1)
        };
        if d >= lookup_values[inum].len() as i32 && d < 1000 {
            d = 1; // map out-of-range to unknown
        }
        ld[inum] = d;
        inum += 1;
    }
    ld[inum..].fill(0);
}

/// `BExpressionMetaData.readMetaData`: reads the lookup table into the way and node contexts. Lines
/// of contexts without a listener are skipped. Errors come wrapped like Java's `RuntimeException`.
pub(crate) fn read_meta(
    lookups_file: &Path,
    mut way: Option<&mut ExpressionContext>,
    mut node: Option<&mut ExpressionContext>,
) -> Result<(), Failure> {
    const CONTEXT_TAG: &str = "---context:";
    const VERSION_TAG: &str = "---lookupversion:";
    const MINOR_VERSION_TAG: &str = "---minorversion:";
    const VARLENGTH_TAG: &str = "---readvarlength";
    const MIN_APP_VERSION_TAG: &str = "---minappversion:";

    let text = read_text(lookups_file)?;
    let mut meta = MetaData::default();
    let mut current: Option<ContextKind> = None;
    for line in java::lines(&text) {
        let line = java::trim(line);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix(CONTEXT_TAG) {
            current = match name {
                "way" if way.is_some() => Some(ContextKind::Way),
                "node" if node.is_some() => Some(ContextKind::Node),
                _ => None,
            };
            continue;
        }
        let version = |tag: &str| line.strip_prefix(tag).map(|v| java::parse_short(v).map_err(Failure::number_format));
        if let Some(v) = version(VERSION_TAG) {
            meta.lookup_version = v?;
            continue;
        }
        if let Some(v) = version(MINOR_VERSION_TAG) {
            meta.lookup_minor_version = v?;
            continue;
        }
        if let Some(v) = version(MIN_APP_VERSION_TAG) {
            meta.min_app_version = v?;
            continue;
        }
        if line.starts_with(VARLENGTH_TAG) {
            continue; // tag removed
        }
        match current {
            Some(ContextKind::Way) => way.as_deref_mut().expect("registered").parse_meta_line(line)?,
            Some(ContextKind::Node) => node.as_deref_mut().expect("registered").parse_meta_line(line)?,
            None => {}
        }
    }
    // Java finishes its listeners in HashMap order, which puts "node" before "way".
    for ctx in [node, way].into_iter().flatten() {
        ctx.finish_meta_parsing()?;
        ctx.meta = meta;
    }
    Ok(())
}

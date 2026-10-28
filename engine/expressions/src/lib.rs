//! Port of `btools.expressions`: BRouter's profile language.
//!
//! A profile (`.brf`) has a `global`, a `way` and a `node` section of `assign` expressions over the
//! tags of the lookup table (`lookups.dat`). A way or node *description* is a bit-coded list of
//! (tag, value index) pairs; evaluating it runs the section's expressions and leaves the outputs the
//! router reads: cost factors, turn cost, classifiers and so on.
//!
//! # Loading a profile
//!
//! [`Profile::load`] repeats `ProfileCache.parseProfile`: a [`WayContext`] with a result cache, a
//! [`NodeContext`] without one, the lookup table read into both, then the way and the node context
//! parsed with the `global` section as a read-only first pass. The request's `profile:` parameters
//! are injected as key values; they replace the matching `assign` in the global section once.
//!
//! ```no_run
//! # use brouter_expressions::Profile;
//! # use std::path::Path;
//! let key_values = [("pass1coefficient".to_string(), "2".to_string())];
//! let profile = Profile::load(Path::new("lookups.dat"), Path::new("trekking.brf"), &key_values, 128 * 512)?;
//! let pass1 = profile.way.variable_value("pass1coefficient", 1.5); // RoutingContext.readGlobalConfig
//! # Ok::<(), brouter_expressions::ExpressionError>(())
//! ```
//!
//! After loading, the router's port of `RoutingContext.readGlobalConfig` reads the global variables
//! from the way context ([`ExpressionContext::variable_value`]), calls
//! [`ExpressionContext::free_no_ways`] unless `check_start_way` is 1, and for a kinematic
//! `---model:` ([`ExpressionContext::model_class`]) registers its outputs with
//! [`ExpressionContext::output_variable_index`] (way `maxspeed`, `maxspeed_explicit`, `minspeed`,
//! node `maxspeed`), reading them back with [`ExpressionContext::build_in_variable`]. `ProfileCache`
//! then calls [`ExpressionContext::set_all_tags_used`] when `processUnusedTags` is set. The server
//! uses `memoryclass * 512` = 65536 as the way cache size. The lookup versions the map decoder checks
//! come from [`ExpressionContext::meta`].
//!
//! # Evaluating
//!
//! ```no_run
//! # use brouter_expressions::{ExpressionError, Profile};
//! # fn f(profile: &mut Profile, way: &[u8], node: &[u8], reverse: bool) -> Result<(), ExpressionError> {
//! profile.way.evaluate(reverse, way)?; // OsmPath: rc.inverseDirection ^ isReverse
//! let cost = profile.way.costfactor();
//! let access_granted = profile.way.node_access_granted() != 0.0;
//! profile.node.evaluate(access_granted, node, &profile.way)?; // StdPath
//! let initial_cost = profile.node.initialcost();
//! let tags = profile.way.key_value_description(reverse, way); // MessageData.wayKeyValues
//! # Ok(()) }
//! ```
//!
//! The getters return the outputs of the context's last evaluation, as Java's do. Node profiles can
//! read the way's outputs (`way:priorityclassifier`); Java links the node context to the way context
//! for that, here the way context is an argument of [`NodeContext::parse_file`] (registers the
//! variable) and [`NodeContext::evaluate`] (reads the way's current outputs, so evaluate the way
//! first). Neither context holds a reference to the other.
//!
//! [`WayContext`] implements the decoder's `TagValueValidator`: `unify` shares equal descriptions
//! through the result cache, `access_type` evaluates a description, `check_start_way` applies the
//! profile's `noStartWay` list. An evaluation can fail only on profile errors (`divide` by zero, a
//! `v:` name missing from the lookup table); `access_type` cannot return the error, so it keeps it,
//! drops this and every further way, and the decoder's caller should fail the route with
//! [`WayContext::take_deferred_error`]. If it does not, the next [`WayContext::evaluate`] returns it.
//!
//! # Java semantics
//!
//! Values are `f32` throughout, evaluated in Java's order. Numbers in profiles, key values and lookup
//! values parse like `Float.parseFloat`; numeric tag values print like `Float.toString`. The result
//! cache is BRouter's `LruMap` with the same bins and eviction order, so evaluation order and cache
//! contents match Java step by step. Key values may come in any order: only variable numbering
//! depends on it, never a value. [`java::parse_float`] and [`java::float_to_string`] are public for
//! the router's own Java-compatible number handling.

mod context;
mod error;
mod expression;
pub mod java;
mod lru_map;

use std::ops::{Deref, DerefMut};
use std::path::Path;

use brouter_codec::TagValueValidator;
use brouter_util::{ByteArrayUnifier, Description};

use context::ContextKind;
pub use context::{ExpressionContext, MetaData};
pub use error::ExpressionError;
use error::Failure;

/// The way context (`BExpressionContextWay`). Shared context methods come through `Deref`.
pub struct WayContext {
    ctx: ExpressionContext,
    decode_forbidden: bool,
    deferred_error: Option<ExpressionError>,
}

/// The node context (`BExpressionContextNode`). Shared context methods come through `Deref`.
pub struct NodeContext {
    ctx: ExpressionContext,
}

/// Reads the lookup table into the way and/or node context (`BExpressionMetaData.readMetaData`).
pub fn read_meta_data(
    lookups_file: &Path,
    way: Option<&mut WayContext>,
    node: Option<&mut NodeContext>,
) -> Result<(), ExpressionError> {
    context::read_meta(lookups_file, way.map(|w| &mut w.ctx), node.map(|n| &mut n.ctx)).map_err(Failure::wrapped)
}

impl WayContext {
    /// `hash_size` is the result cache's capacity in descriptions (Java's default: 4096). Zero
    /// disables the cache; `access_type` needs one, in Java as here.
    pub fn new(hash_size: usize) -> Self {
        Self { ctx: ExpressionContext::new(ContextKind::Way, hash_size), decode_forbidden: true, deferred_error: None }
    }

    /// `parseFile(file, "global", keyValues)`: the `global` section with the key values injected,
    /// then the `way` section.
    pub fn parse_file(&mut self, file: &Path, key_values: &[(String, String)]) -> Result<(), ExpressionError> {
        self.ctx.parse_file(file, key_values, None)
    }

    /// `evaluate(inverseDirection, description)`.
    /// An error `TagValueValidator::access_type` kept and nobody took comes back here first, so it
    /// still stops the route as Java's exception would.
    pub fn evaluate(&mut self, inverse_direction: bool, description: &[u8]) -> Result<(), ExpressionError> {
        if let Some(e) = self.deferred_error.take() {
            return Err(e);
        }
        self.ctx.evaluate_description(inverse_direction, description, None)
    }

    /// `accessType`: 2 = usable, 1 = no matching (decode only), 0 = drop. Leaves the context with the
    /// forward results, or the reverse ones when the forward cost factor is 9999 or more.
    pub fn try_access_type(&mut self, description: &[u8]) -> Result<i32, ExpressionError> {
        self.evaluate(false, description)?;
        let mut min_cost_factor = self.costfactor();
        if min_cost_factor >= 9999.0 {
            self.ctx.set_inverse_vars();
            // Without a cache there are no reverse results: Java's ArrayIndexOutOfBoundsException.
            let n = self.build_in_variable_count();
            let reverse_cost_factor = *self
                .ctx
                .current_build_in_values()
                .and_then(<[f32]>::first)
                .ok_or_else(|| ExpressionError(format!("Index {n} out of bounds for length {n}")))?;
            if reverse_cost_factor < min_cost_factor {
                min_cost_factor = reverse_cost_factor;
            }
        }
        Ok(if min_cost_factor < 9999.0 {
            2
        } else if self.decode_forbidden && min_cost_factor < 10000.0 {
            1
        } else {
            0
        })
    }

    /// The first evaluation error `TagValueValidator::access_type` swallowed.
    pub fn take_deferred_error(&mut self) -> Option<ExpressionError> {
        self.deferred_error.take()
    }

    pub fn costfactor(&self) -> f32 {
        self.build_in_variable(0)
    }
    pub fn turncost(&self) -> f32 {
        self.build_in_variable(1)
    }
    pub fn uphill_costfactor(&self) -> f32 {
        self.build_in_variable(2)
    }
    pub fn downhill_costfactor(&self) -> f32 {
        self.build_in_variable(3)
    }
    pub fn initialcost(&self) -> f32 {
        self.build_in_variable(4)
    }
    pub fn node_access_granted(&self) -> f32 {
        self.build_in_variable(5)
    }
    pub fn initial_classifier(&self) -> f32 {
        self.build_in_variable(6)
    }
    pub fn traffic_source_density(&self) -> f32 {
        self.build_in_variable(7)
    }
    pub fn is_traffic_backbone(&self) -> f32 {
        self.build_in_variable(8)
    }
    pub fn priority_classifier(&self) -> f32 {
        self.build_in_variable(9)
    }
    pub fn classifier_mask(&self) -> f32 {
        self.build_in_variable(10)
    }
    pub fn maxspeed(&self) -> f32 {
        self.build_in_variable(11)
    }
    pub fn uphillcost(&self) -> f32 {
        self.build_in_variable(12)
    }
    pub fn downhillcost(&self) -> f32 {
        self.build_in_variable(13)
    }
    pub fn uphillcutoff(&self) -> f32 {
        self.build_in_variable(14)
    }
    pub fn downhillcutoff(&self) -> f32 {
        self.build_in_variable(15)
    }
    pub fn uphillmaxslope(&self) -> f32 {
        self.build_in_variable(16)
    }
    pub fn downhillmaxslope(&self) -> f32 {
        self.build_in_variable(17)
    }
    pub fn uphillmaxslopecost(&self) -> f32 {
        self.build_in_variable(18)
    }
    pub fn downhillmaxslopecost(&self) -> f32 {
        self.build_in_variable(19)
    }
}

impl NodeContext {
    /// Without a result cache, as `ProfileCache` creates it: a cache would key node results on the
    /// node description alone, although `way:` variables make them depend on the way too.
    pub fn new() -> Self {
        Self { ctx: ExpressionContext::new(ContextKind::Node, 0) }
    }

    /// `parseFile(file, "global", keyValues)`; `way` is the foreign context for `way:` variables
    /// (`setForeignContext`) and must be parsed already.
    pub fn parse_file(
        &mut self,
        file: &Path,
        key_values: &[(String, String)],
        way: &mut WayContext,
    ) -> Result<(), ExpressionError> {
        self.ctx.parse_file(file, key_values, Some(&mut way.ctx))
    }

    /// `evaluate(nodeAccessGranted, description)`; `way:` variables read `way`'s last results.
    pub fn evaluate(
        &mut self,
        inverse_direction: bool,
        description: &[u8],
        way: &WayContext,
    ) -> Result<(), ExpressionError> {
        self.ctx.evaluate_description(inverse_direction, description, way.ctx.current_build_in_values())
    }

    pub fn initialcost(&self) -> f32 {
        self.build_in_variable(0)
    }
}

impl Deref for WayContext {
    type Target = ExpressionContext;
    fn deref(&self) -> &ExpressionContext {
        &self.ctx
    }
}

impl DerefMut for WayContext {
    fn deref_mut(&mut self) -> &mut ExpressionContext {
        &mut self.ctx
    }
}

impl Deref for NodeContext {
    type Target = ExpressionContext;
    fn deref(&self) -> &ExpressionContext {
        &self.ctx
    }
}

impl DerefMut for NodeContext {
    fn deref_mut(&mut self) -> &mut ExpressionContext {
        &mut self.ctx
    }
}

impl ByteArrayUnifier for WayContext {
    fn unify(&mut self, ab: &[u8], offset: usize, len: usize) -> Description {
        self.ctx.unify(ab, offset, len)
    }
}

impl TagValueValidator for WayContext {
    /// After an error (Java's exception ends the decoding) every way is dropped until the error is
    /// taken with [`WayContext::take_deferred_error`] or returned by [`WayContext::evaluate`].
    fn access_type(&mut self, tag_value_set: &[u8]) -> i32 {
        if self.deferred_error.is_some() {
            return 0;
        }
        self.try_access_type(tag_value_set).unwrap_or_else(|e| {
            self.deferred_error = Some(e);
            0
        })
    }

    fn is_lookup_idx_used(&self, idx: usize) -> bool {
        self.ctx.is_lookup_idx_used(idx)
    }

    fn set_decode_forbidden(&mut self, decode_forbidden: bool) {
        self.decode_forbidden = decode_forbidden;
    }

    fn check_start_way(&mut self, ab: &[u8]) -> bool {
        self.ctx.check_start_way(ab)
    }

    fn lookup_version(&self) -> i16 {
        self.ctx.meta().lookup_version
    }

    fn lookup_minor_version(&self) -> i16 {
        self.ctx.meta().lookup_minor_version
    }
}

impl Default for NodeContext {
    fn default() -> Self {
        Self::new()
    }
}

/// A parsed profile: the way and node contexts as `ProfileCache` sets them up.
pub struct Profile {
    pub way: WayContext,
    pub node: NodeContext,
}

impl Profile {
    /// `ProfileCache.parseProfile` without the caching: reads the lookup table and parses the profile
    /// for both contexts, injecting `key_values` (the request's `profile:` parameters).
    pub fn load(
        lookups_file: &Path,
        profile_file: &Path,
        key_values: &[(String, String)],
        way_hash_size: usize,
    ) -> Result<Self, ExpressionError> {
        let mut way = WayContext::new(way_hash_size);
        let mut node = NodeContext::new();
        read_meta_data(lookups_file, Some(&mut way), Some(&mut node))?;
        way.parse_file(profile_file, key_values)?;
        node.parse_file(profile_file, key_values, &mut way)?;
        Ok(Self { way, node })
    }
}

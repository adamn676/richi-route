//! Port of `btools.codec`, decoding side.

mod buffers;
mod micro_cache;
mod stat_coder;
mod tag_value_coder;

pub use buffers::{DataBuffers, LinkedListContainer};
pub use micro_cache::{MicroCache, decode_transfer_nodes, expand_id32};
pub use stat_coder::{NoisyDiffCoder, StatCoderContext};
pub use tag_value_coder::{TagValueCoder, TagValueWrapper};

use brouter_util::ByteArrayUnifier;

/// Port of `TagValueValidator`, implemented by the way profile so the decoder can drop ways the profile
/// cannot use. The lookup versions come from the profile's `lookups.dat` (`BExpressionMetaData`).
pub trait TagValueValidator: ByteArrayUnifier {
    /// 0 = nothing, 1 = no matching, 2 = normal.
    fn access_type(&mut self, tag_value_set: &[u8]) -> i32;
    fn is_lookup_idx_used(&self, idx: usize) -> bool;
    fn set_decode_forbidden(&mut self, decode_forbidden: bool);
    fn check_start_way(&mut self, ab: &[u8]) -> bool;
    fn lookup_version(&self) -> i16;
    fn lookup_minor_version(&self) -> i16;
}

/// Port of `WaypointMatcher`: receives the geometry of every usable way while a cell is decoded, to find
/// the ways closest to the waypoints.
pub trait WaypointMatcher {
    fn start(
        &mut self,
        ilon_start: i32,
        ilat_start: i32,
        ilon_target: i32,
        ilat_target: i32,
        use_as_start_way: bool,
    ) -> bool;
    fn transfer_node(&mut self, ilon: i32, ilat: i32);
    fn end(&mut self);
    fn has_match(&self, lon: i32, lat: i32) -> bool;
}

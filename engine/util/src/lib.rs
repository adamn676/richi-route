//! Port of `btools.util`.

mod bit_coder;
mod byte_array_cache;
mod byte_data;
pub mod cheap_ruler;
#[rustfmt::skip]
mod cheap_ruler_table;
mod crc32;
pub mod jmath;
mod long_map;
mod sorted_heap;

pub use bit_coder::{BitCoderContext, BitWriter};
pub use byte_array_cache::ByteArrayCache;
pub use byte_data::{ByteDataReader, ByteDataWriter};
pub use cheap_ruler::CheapAngleMeter;
pub use crc32::crc;
pub use long_map::{CompactLongMap, FrozenLongMap};
pub use sorted_heap::SortedHeap;

use std::rc::Rc;

/// A way or node description: BRouter's tag-value bitmap. Unified descriptions share one allocation,
/// so `Rc::ptr_eq` stands in for Java's reference comparison of `byte[]`.
pub type Description = Rc<[u8]>;

/// Port of `IByteArrayUnifier`: returns the shared copy of `ab[offset..offset + len]`.
pub trait ByteArrayUnifier {
    fn unify(&mut self, ab: &[u8], offset: usize, len: usize) -> Description;
}

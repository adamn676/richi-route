//! Port of `btools.mapaccess`: reads `.rd5` routing segments on demand into the graph the router walks.
//!
//! # Graph API (for the router)
//!
//! - **Arenas.** `OsmNodesMap` owns all nodes, links and turn restrictions. They are addressed by
//!   `NodeIdx`, `LinkIdx` and `RestrictionIdx` (`u32` newtypes; `Option<_>` is Java's `null`). Compare
//!   indices where Java compares references. Nothing is freed before the map is dropped. Read them with
//!   `map.node(n)` / `map.link(l)`, change them with `node_mut` / `link_mut`.
//! - **Nodes.** `OsmNode` has `ilon`, `ilat`, `selev`, `node_description`, `visit_id` and `firstlink`.
//!   A *hollow* node (`is_hollow()`) is a placeholder whose position is known but whose cell is not
//!   loaded; `NodesCache::obtain_non_hollow_node` loads it. Java's `OsmNode` extends `OsmLink`; that
//!   inherited link is `OsmNode::own_link()`, which the decoder uses for one of the node's links (so
//!   `map.link(node.own_link()).description_bitmap` is Java's `node.descriptionBitmap`).
//! - **Links.** An `OsmLink` connects `n1 -> n2` (the way's direction) and sits in the chains of both
//!   nodes. Walk a chain with `node.firstlink` and `link.next(node)`, or `map.links(node)` when the
//!   loop doesn't change the graph. The neighbour is
//!   `link.target(node)`, and `link.is_reverse(node)` tells the direction. `map.target(l, n)` and
//!   `map.next_link(l, n)` are shorthands. `map.unlink_link(node, link)` removes one direction: the link
//!   stays usable from the other node, and once both directions are gone, `is_link_unused()` is true.
//!   The source arguments take `impl Into<Option<NodeIdx>>`, so pass `n`, or `None` where Java passes
//!   `null` (the start link from `map.create_link(None, Some(start))`).
//! - **Geometry.** `link.geometry` holds the transfer nodes in the forward direction (a `Geometry`, a
//!   slice of its cell's data that derefs to Java's bytes), and `link.description_bitmap` the way tags.
//!   Both compare by identity like Java's arrays (`Geometry::same`, `Rc::ptr_eq`).
//!   `GeometryDecoder::decode_geometry` returns the transfer nodes with elevations for either direction.
//! - **Turn restrictions.** `map.restrictions(node)` lists them in Java's order, for
//!   `TurnRestriction::is_turn_forbidden`.
//! - **Link holders.** Java links keep a list of router paths per direction (`OsmLinkHolder`). Here a
//!   link stores only the first path of each direction, as an opaque `u32` handle the router chooses
//!   (e.g. an index into its path arena). The router keeps each path's `next_for_link`. The contract:
//!   `link.add_link_holder(h, source)` returns the previous first holder, which the router must store as
//!   `h`'s `next_for_link` when it is `Some` (Java's `setNextForLink`). `first_link_holder(source)`
//!   starts the walk. Clearing a direction (`unlink_link`) drops its holder. Handles must be below
//!   `u32::MAX`, which marks "none".
//! - **Search state.** `OsmNodesMap` keeps the router-facing fields `cleanup_mode`, `current_max_cost`,
//!   `current_path_cost`, `destination`, `end_node1/2` and `nodes_created`, and the memory checks
//!   `is_in_memory_bounds`, `collect_outreachers`, `can_escape` and `clear_temp`.
//!
//! # Cache lifetime
//!
//! A `SegmentStore` (in an `Arc`, shared by all threads) holds the segment directory, the open files
//! and a bounded cache of decoded cells. Create a `NodesCache` from it per search, passing the
//! previous one (`&mut Option`, taken on success) to reuse its files and still-virgin cells, as
//! `RoutingEngine.resetCache` does. Afterwards call `clean(false)` (or `clean(true)` after an island).
//! Methods that may decode take the way profile as `&mut dyn TagValueValidator`. Decoding errors come
//! back as `MapError`, carrying BRouter's message and exception kind. Java's internal-error exceptions
//! on inconsistent link state ("unknown source", "UUUUPS") are panics here: they only happen if the
//! graph is used against its contract.
//!
//! What the store shares between searches never changes a result; see `SegmentStore`.
//!
//! The arenas only grow during a search: where Java's garbage collector frees nodes that `vanish` and
//! the memory checks cut off, they stay allocated until the next search of the chain reuses them.
//! `nodes_created` follows Java's accounting, not the memory in use.

mod direct_weaver;
mod files;
mod geometry;
mod graph;
mod node_hash;
mod nodes_cache;
mod pos;
mod store;
mod waypoints;

pub use geometry::{Geometry, GeometryDecoder, OsmTransferNode};
pub use graph::{LinkIdx, NodeIdx, OsmLink, OsmNode, OsmNodesMap, RestrictionIdx, TurnRestriction};
pub use nodes_cache::{ElevationTypes, NodesCache};
pub use pos::{OsmPos, Pos};
pub use store::SegmentStore;
pub use waypoints::{MatchedWaypoint, OsmNodePairSet, WaypointMatcherImpl};

use std::fmt;

/// An exception from the data layer, with BRouter's message. The router reports both kinds by message
/// but treats `IllegalArgument` specially in places (`RoutingEngine.searchRoutedTrack`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MapError {
    /// Java `IllegalArgumentException`, e.g. `datafile E10_N45.rd5 not found`.
    IllegalArgument(String),
    /// Any other `RuntimeException`, e.g. an I/O or checksum error wrapped by `NodesCache`.
    Runtime(String),
}

impl MapError {
    pub fn message(&self) -> &str {
        match self {
            MapError::IllegalArgument(m) | MapError::Runtime(m) => m,
        }
    }
}

impl fmt::Display for MapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for MapError {}

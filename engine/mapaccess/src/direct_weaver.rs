//! Port of `DirectWeaver`, in two steps. `DecodedCell::decode` reads a cell's bit stream into a compact
//! form that does not depend on the profile, so searches and threads can share it (see `store`).
//! `weave` then does what Java's decoder does with each value: it makes the same `unify`,
//! `accessType` and `checkStartWay` calls and matcher calls, in the same order, and builds the same
//! graph. Only `isLookupIdxUsed`, a query without side effects, is asked once per lookup instead of
//! once per tag.

use crate::store::lock;
use crate::{Geometry, NodeIdx, OsmNodesMap, TurnRestriction};
use brouter_codec::{
    NoisyDiffCoder, StatCoderContext, TagTree, TagValueValidator, TagValueWrapper, WaypointMatcher,
    decode_transfer_nodes, expand_id32, match_transfer_nodes,
};
use brouter_util::{BitCoderContext, ByteDataWriter, Description};
use std::mem::size_of;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

/// A cell as the bit stream gives it.
pub(crate) struct DecodedCell {
    /// The cell's corner, `(lon, lat)`.
    base: (i32, i32),
    /// The start of the cell's data up to the end of the way `TagTree`, to read it again for a profile
    /// with other used lookups.
    way_tree: Box<[u8]>,
    /// The lookup indices the way tag sets use, sorted.
    way_lookups: Vec<i32>,
    /// The way tag sets re-encoded for the sets of used lookups of recent profiles.
    filtered_way_tags: Mutex<Vec<Arc<FilteredTags>>>,
    /// The node tag sets, as the validator-less `TagValueCoder` encodes them.
    node_tags: TagSets,
    nodes: Vec<CellNode>,
    /// Turn restrictions in stream order, with the index of their node.
    restrictions: Vec<(u32, TurnRestriction)>,
    links: Vec<CellLink>,
    /// The links to other cells, in link order.
    external_links: Vec<ExternalLink>,
    /// The transfer nodes of each forward link, encoded as `OsmLink::geometry`.
    geometry: Arc<[u8]>,
}

struct CellNode {
    /// Position relative to the cell's corner (cells are less than 2^15 wide).
    dlon: u16,
    dlat: u16,
    selev: i16,
    node_tags: u32,
    links_end: u32,
}

impl CellNode {
    fn position(&self, (lon_base, lat_base): (i32, i32)) -> (i32, i32) {
        (lon_base.wrapping_add(i32::from(self.dlon)), lat_base.wrapping_add(i32::from(self.dlat)))
    }
}

struct CellLink {
    /// The target's index in the cell; the link's own node for a link to another cell.
    target: u32,
    way_tags: u32,
    geometry_end: u32,
}

struct ExternalLink {
    dlon: i32,
    dlat: i32,
    is_reverse: bool,
}

/// Encoded tag sets, one after the other; an empty one is Java's `null`.
#[derive(Default, PartialEq, Debug)]
struct TagSets {
    bytes: Vec<u8>,
    ends: Vec<u32>,
}

impl TagSets {
    /// The tree's leaves with the pairs whose lookup passes `used` (`TagTree::encode_leaf`).
    fn encode(tree: &TagTree, mut used: impl FnMut(i32) -> bool) -> Self {
        let mut sets = Self::default();
        let mut tagbuf = Vec::new();
        for leaf in 0..tree.leaf_count() as u32 {
            sets.bytes.extend_from_slice(tree.encode_leaf(leaf, &mut used, &mut tagbuf).unwrap_or_default());
            sets.ends.push(sets.bytes.len() as u32);
        }
        sets.bytes.shrink_to_fit();
        sets.ends.shrink_to_fit();
        sets
    }

    /// Start and length of each tag set in `bytes`.
    fn ranges(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        let mut start = 0;
        self.ends.iter().map(move |&end| {
            let range = (start, end as usize - start);
            start = end as usize;
            range
        })
    }

    fn heap_bytes(&self) -> usize {
        self.bytes.capacity() + self.ends.capacity() * size_of::<u32>()
    }
}

/// A cell's way tag sets as `TagValueCoder` re-encodes them for a validator: only the pairs whose
/// lookup the profile uses.
struct FilteredTags {
    /// Per entry of `DecodedCell::way_lookups`: does the profile use it?
    used: Vec<bool>,
    tags: TagSets,
}

impl FilteredTags {
    fn new(tree: &TagTree, lookups: &[i32], used: Vec<bool>) -> Self {
        let tags = TagSets::encode(tree, |inum| used[lookups.binary_search(&inum).expect("lookup of the cell")]);
        Self { used, tags }
    }

    fn heap_bytes(&self) -> usize {
        size_of::<Self>() + self.used.capacity() + self.tags.heap_bytes()
    }
}

/// Per lookup index: does the validator use it?
fn used_lookups(lookups: &[i32], validator: &dyn TagValueValidator, used: &mut Vec<bool>) {
    used.clear();
    used.extend(lookups.iter().map(|&inum| validator.is_lookup_idx_used(inum as usize)));
}

/// How many sets of used lookups (profiles) a cell keeps re-encoded tags for.
const FILTERED_TAG_SETS: usize = 4;

/// Scratch space of `weave`, reused between cells.
#[derive(Default)]
pub(crate) struct WeaveBuffers {
    used: Vec<bool>,
    way_tags: Vec<Option<TagValueWrapper>>,
    node_tags: Vec<Option<Description>>,
    nodes: Vec<NodeIdx>,
}

impl DecodedCell {
    /// Decodes the cell. The validator is only asked which lookups it uses, to re-encode the way tag
    /// sets for it right away.
    pub(crate) fn decode(
        ab: &[u8],
        lon_idx: i32,
        lat_idx: i32,
        divisor: i32,
        validator: &dyn TagValueValidator,
    ) -> Self {
        let bc = &mut StatCoderContext::new(ab);
        let cellsize = 1_000_000 / divisor;
        let base = (lon_idx.wrapping_mul(cellsize), lat_idx.wrapping_mul(cellsize));

        let way_tree = TagTree::decode(bc);
        let way_tree_bytes = ab[..(bc.reading_bit_position() as usize).div_ceil(8)].into();
        let way_lookups = way_tree.lookup_indices();
        let mut used = Vec::new();
        used_lookups(&way_lookups, validator, &mut used);
        let filtered_way_tags = FilteredTags::new(&way_tree, &way_lookups, used);
        let node_tree = TagTree::decode(bc);
        let node_idx_diff = NoisyDiffCoder::new(bc);
        let node_ele_diff = NoisyDiffCoder::new(bc);
        let ext_lon_diff = NoisyDiffCoder::new(bc);
        let ext_lat_diff = NoisyDiffCoder::new(bc);
        let trans_ele_diff = NoisyDiffCoder::new(bc);

        let size = bc.decode_noisy_number(5);
        let mut faid = vec![0; size as usize];
        bc.decode_sorted_array(&mut faid, 0, size, 29, 0);
        let mut nodes: Vec<CellNode> = faid
            .iter()
            .map(|&id32| {
                let d = expand_id32(id32);
                CellNode { dlon: (d >> 32) as u16, dlat: d as u16, selev: 0, node_tags: 0, links_end: 0 }
            })
            .collect();

        let _netdatasize = bc.decode_noisy_number(10); // (not needed for direct weaving)

        let mut restrictions = Vec::new();
        let mut links = Vec::new();
        let mut external_links = Vec::new();
        let mut w = ByteDataWriter::default();
        let mut selev = 0i32;
        for n in 0..nodes.len() {
            let (ilon, ilat) = nodes[n].position(base);

            // future escapes (turn restrictions?)
            let mut tr_exceptions: i16 = 0;
            loop {
                let feature_id = bc.decode_var_bits();
                if feature_id == 0 {
                    break;
                }
                let bitsize = bc.decode_noisy_number(5);

                if feature_id == 2 {
                    // exceptions to turn-restriction
                    tr_exceptions = bc.decode_bounded(1023) as i16;
                } else if feature_id == 1 {
                    // turn-restriction
                    let exceptions = tr_exceptions;
                    tr_exceptions = 0;
                    let is_positive = bc.decode_bit();
                    let from_lon = ilon.wrapping_add(bc.decode_noisy_diff(10));
                    let from_lat = ilat.wrapping_add(bc.decode_noisy_diff(10));
                    let to_lon = ilon.wrapping_add(bc.decode_noisy_diff(10));
                    let to_lat = ilat.wrapping_add(bc.decode_noisy_diff(10));
                    let tr = TurnRestriction::new(is_positive, exceptions, from_lon, from_lat, to_lon, to_lat);
                    restrictions.push((n as u32, tr));
                } else {
                    for _ in 0..bitsize {
                        bc.decode_bit(); // unknown feature, just skip
                    }
                }
            }

            selev = selev.wrapping_add(node_ele_diff.decode_signed_value(bc));
            let node_tags = node_tree.decode_leaf(bc);

            let link_count = bc.decode_noisy_number(1);
            for _ in 0..link_count {
                let node_idx = (n as i32).wrapping_add(node_idx_diff.decode_signed_value(bc)) as usize;

                let (dlon_remaining, dlat_remaining);
                let mut is_reverse = false;
                if node_idx != n {
                    // internal (forward-) link
                    dlon_remaining = i32::from(nodes[node_idx].dlon) - i32::from(nodes[n].dlon);
                    dlat_remaining = i32::from(nodes[node_idx].dlat) - i32::from(nodes[n].dlat);
                } else {
                    is_reverse = bc.decode_bit();
                    dlon_remaining = ext_lon_diff.decode_signed_value(bc);
                    dlat_remaining = ext_lat_diff.decode_signed_value(bc);
                    external_links.push(ExternalLink { dlon: dlon_remaining, dlat: dlat_remaining, is_reverse });
                }

                let way_tags = way_tree.decode_leaf(bc);

                if !is_reverse {
                    // geometry for forward links only
                    decode_transfer_nodes(bc, &trans_ele_diff, Some(&mut w), (dlon_remaining, dlat_remaining));
                }
                links.push(CellLink { target: node_idx as u32, way_tags, geometry_end: w.aboffset as u32 });
            }

            let node = &mut nodes[n];
            node.selev = selev as i16;
            node.node_tags = node_tags;
            node.links_end = links.len() as u32;
        }

        restrictions.shrink_to_fit();
        links.shrink_to_fit();
        external_links.shrink_to_fit();
        Self {
            base,
            way_tree: way_tree_bytes,
            way_lookups,
            filtered_way_tags: Mutex::new(vec![Arc::new(filtered_way_tags)]),
            node_tags: TagSets::encode(&node_tree, |_| true),
            nodes,
            restrictions,
            links,
            external_links,
            geometry: w.data()[..w.aboffset].into(),
        }
    }

    /// The way tag sets re-encoded for this set of used lookups, and by how many bytes the cell grew.
    fn filtered_way_tags(&self, used: &[bool]) -> (Arc<FilteredTags>, isize) {
        // the sets are kept least recently used first
        let find = |sets: &mut Vec<Arc<FilteredTags>>| {
            let i = sets.iter().position(|set| set.used == used)?;
            let set = sets.remove(i);
            sets.push(set.clone());
            Some(set)
        };
        if let Some(set) = find(&mut lock(&self.filtered_way_tags)) {
            return (set, 0);
        }
        let tree = TagTree::decode(&mut BitCoderContext::new(&self.way_tree));
        let set = Arc::new(FilteredTags::new(&tree, &self.way_lookups, used.to_vec()));
        let mut sets = lock(&self.filtered_way_tags);
        if let Some(other) = find(&mut sets) {
            return (other, 0); // another thread was faster
        }
        let mut grown = set.heap_bytes() as isize;
        if sets.len() == FILTERED_TAG_SETS {
            grown -= sets.remove(0).heap_bytes() as isize;
        }
        sets.push(set.clone());
        (set, grown)
    }

    /// Approximate heap use, for the store's budget.
    pub(crate) fn heap_bytes(&self) -> usize {
        size_of::<Self>()
            + self.way_tree.len()
            + lock(&self.filtered_way_tags).iter().map(|set| set.heap_bytes()).sum::<usize>()
            + self.way_lookups.capacity() * size_of::<i32>()
            + self.node_tags.heap_bytes()
            + self.nodes.capacity() * size_of::<CellNode>()
            + self.restrictions.capacity() * size_of::<(u32, TurnRestriction)>()
            + self.links.capacity() * size_of::<CellLink>()
            + self.external_links.capacity() * size_of::<ExternalLink>()
            + self.geometry.len()
    }
}

/// Weaves a decoded cell into the graph, as `DirectWeaver`'s constructor does while decoding. Returns
/// by how many bytes the cell grew (re-encoded way tags for a new profile), for the store's budget.
pub(crate) fn weave(
    cell: &DecodedCell,
    buffers: &mut WeaveBuffers,
    way_validator: &mut dyn TagValueValidator,
    mut waypoint_matcher: Option<&mut dyn WaypointMatcher>,
    hollow_nodes: &mut OsmNodesMap,
) -> isize {
    let WeaveBuffers { used, way_tags, node_tags, nodes } = buffers;

    // TagValueCoder with the validator: its calls for each leaf, in tree order
    used_lookups(&cell.way_lookups, way_validator, used);
    let (filtered, grown) = cell.filtered_way_tags(used);
    way_tags.clear();
    way_tags.extend(filtered.tags.ranges().map(|(offset, len)| {
        (len > 0).then(|| TagValueWrapper::validated(way_validator, &filtered.tags.bytes, offset, len)).flatten()
    }));
    // ... and without one: fresh copies
    node_tags.clear();
    node_tags.extend(
        cell.node_tags
            .ranges()
            .map(|(start, len)| (len > 0).then(|| Rc::from(&cell.node_tags.bytes[start..start + len]))),
    );

    nodes.clear();
    for cn in &cell.nodes {
        let (ilon, ilat) = cn.position(cell.base);
        let node = match hollow_nodes.get(ilon, ilat) {
            None => hollow_nodes.create_node(ilon, ilat),
            Some(node) => {
                hollow_nodes.node_mut(node).visit_id = 1;
                hollow_nodes.remove(node);
                node
            }
        };
        nodes.push(node);
    }

    let cell_geometry = Rc::new(cell.geometry.clone());
    let mut restrictions = cell.restrictions.iter().peekable();
    let mut external_links = cell.external_links.iter();
    let (mut links_start, mut geometry_start) = (0, 0);
    for (n, cn) in cell.nodes.iter().enumerate() {
        let node = nodes[n];
        let (ilon, ilat) = cn.position(cell.base);

        while let Some((_, tr)) = restrictions.next_if(|(tr_node, _)| *tr_node as usize == n) {
            hollow_nodes.add_turn_restriction(node, tr.clone());
        }

        let osm_node = hollow_nodes.node_mut(node);
        osm_node.selev = cn.selev;
        osm_node.node_description = node_tags[cn.node_tags as usize].clone(); // TODO in Java: unified?

        for link in &cell.links[links_start..cn.links_end as usize] {
            let target = link.target as usize;
            let (dlon, dlat, is_reverse) = if target != n {
                let (tlon, tlat) = cell.nodes[target].position(cell.base);
                (tlon.wrapping_sub(ilon), tlat.wrapping_sub(ilat), false)
            } else {
                let ext = external_links.next().expect("external link");
                (ext.dlon, ext.dlat, ext.is_reverse)
            };
            let geometry_range = geometry_start..link.geometry_end as usize;
            geometry_start = link.geometry_end as usize;
            let way_tags = way_tags[link.way_tags as usize].as_ref();

            if !is_reverse {
                let geometry = &cell.geometry[geometry_range.clone()];
                let matcher = waypoint_matcher.as_deref_mut();
                match_transfer_nodes(geometry, way_tags, way_validator, matcher, (ilon, ilat), (dlon, dlat));
            }

            if let Some(tags) = way_tags {
                let geometry = (!geometry_range.is_empty())
                    .then(|| Geometry::new(&cell_geometry, geometry_range.start, geometry_range.end));
                if target != n {
                    // valid internal (forward-) link
                    let node2 = nodes[target];
                    let l = hollow_nodes.reusable_link(node, node2);
                    let osm_link = hollow_nodes.link_mut(l);
                    osm_link.description_bitmap = Some(tags.data.clone());
                    osm_link.geometry = geometry;
                    hollow_nodes.add_link(node, l, is_reverse, node2);
                } else {
                    // weave external link
                    let (linklon, linklat) = (ilon.wrapping_add(dlon), ilat.wrapping_add(dlat));
                    hollow_nodes.add_link_to(node, linklon, linklat, Some(tags.data.clone()), geometry, is_reverse);
                    hollow_nodes.node_mut(node).visit_id = 1;
                }
            }
        } // ... loop over links
        links_start = cn.links_end as usize;
    } // ... loop over nodes

    hollow_nodes.cleanup_and_count(nodes);
    grown
}

#[cfg(test)]
mod tests {
    use super::*;
    use brouter_util::{BitWriter, ByteArrayUnifier};

    /// A validator that only answers which lookups it uses.
    struct Lookups(fn(usize) -> bool);

    impl ByteArrayUnifier for Lookups {
        fn unify(&mut self, _: &[u8], _: usize, _: usize) -> Description {
            unreachable!()
        }
    }

    impl TagValueValidator for Lookups {
        fn access_type(&mut self, _: &[u8]) -> i32 {
            unreachable!()
        }
        fn is_lookup_idx_used(&self, idx: usize) -> bool {
            (self.0)(idx)
        }
        fn set_decode_forbidden(&mut self, _: bool) {}
        fn check_start_way(&mut self, _: &[u8]) -> bool {
            unreachable!()
        }
        fn lookup_version(&self) -> i16 {
            0
        }
        fn lookup_minor_version(&self) -> i16 {
            0
        }
    }

    /// A cell without nodes whose way tree is node(node(leaf, leaf), leaf).
    fn cell_without_nodes() -> Vec<u8> {
        let mut bw = BitWriter::new();
        bw.encode_bit(true);
        bw.encode_bit(true);
        for leaf in [&[(1, 5), (3, 2), (9, 1)][..], &[], &[(3, 7), (4, 0), (12, 3)]] {
            bw.encode_bit(false);
            let mut last = 0;
            for &(inum, data) in leaf {
                bw.encode_var_bits(inum - last);
                bw.encode_var_bits(data);
                last = inum;
            }
            bw.encode_var_bits(0);
        }
        bw.encode_bit(false); // node tree: one empty leaf
        bw.encode_var_bits(0);
        for _ in 0..5 {
            bw.encode_var_bits(3); // the noisy diff coders
        }
        bw.encode_bounded(31, 0); // no nodes
        bw.encode_var_bits(0);
        bw.encode_bounded(1023, 0); // netdatasize
        bw.encode_var_bits(0);
        bw.finish()
    }

    #[test]
    fn another_profile_reads_the_way_tree_again() {
        let ab = cell_without_nodes();
        let cell = DecodedCell::decode(&ab, 0, 0, 32, &Lookups(|idx| idx != 3));
        let tree = TagTree::decode(&mut BitCoderContext::new(&ab));
        assert_eq!(cell.way_lookups, [1, 3, 4, 9, 12]);
        for used in [[true, false, true, true, true], [false, true, false, false, true], [false; 5]] {
            let (filtered, grown) = cell.filtered_way_tags(&used);
            assert_eq!(filtered.tags, FilteredTags::new(&tree, &cell.way_lookups, used.to_vec()).tags);
            assert_eq!(grown != 0, used != [true, false, true, true, true]);
        }
        let none_used: Vec<_> = cell.filtered_way_tags(&[false; 5]).0.tags.ranges().collect();
        assert_eq!(none_used, [(0, 0), (0, 0), (0, 0)]); // every leaf is Java's null
    }
}

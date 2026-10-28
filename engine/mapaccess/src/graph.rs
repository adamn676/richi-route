//! Ports of `OsmNode`, `OsmLink`, `TurnRestriction` and `OsmNodesMap`: the router's graph, stored in
//! arenas inside `OsmNodesMap`.

use crate::MapError;
use crate::node_hash::NodeHashMap;
use crate::pos::OsmPos;
use brouter_util::{ByteArrayCache, ByteArrayUnifier, ByteDataReader, Description};
use std::num::NonZeroU32;
use std::rc::Rc;

macro_rules! arena_index {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
        pub struct $name(NonZeroU32);

        impl $name {
            pub(crate) fn from_index(i: usize) -> Self {
                Self(NonZeroU32::new(i as u32 + 1).expect("arena index overflow"))
            }

            /// Position in the arena (stable for the life of the `OsmNodesMap`).
            pub fn index(self) -> usize {
                (self.0.get() - 1) as usize
            }
        }
    };
}

arena_index!(
    /// A node in `OsmNodesMap`. Java compares `OsmNode`s by reference; compare these instead.
    NodeIdx
);
arena_index!(
    /// A link in `OsmNodesMap`.
    LinkIdx
);
arena_index!(
    /// A turn restriction in `OsmNodesMap`.
    RestrictionIdx
);

/// `selev` of a hollow node: only its position is known so far.
const HOLLOW_SELEV: i16 = -12345;

/// Port of `TurnRestriction`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TurnRestriction {
    pub is_positive: bool,
    pub exceptions: i16,
    pub from_lon: i32,
    pub from_lat: i32,
    pub to_lon: i32,
    pub to_lat: i32,
    next: Option<RestrictionIdx>,
}

impl TurnRestriction {
    pub fn new(is_positive: bool, exceptions: i16, from_lon: i32, from_lat: i32, to_lon: i32, to_lat: i32) -> Self {
        Self { is_positive, exceptions, from_lon, from_lat, to_lon, to_lat, next: None }
    }

    pub fn except_bikes(&self) -> bool {
        self.exceptions & 1 != 0
    }

    pub fn except_motorcars(&self) -> bool {
        self.exceptions & 2 != 0
    }

    /// `TurnRestriction.isTurnForbidden` over a node's restrictions (`OsmNodesMap::restrictions`).
    pub fn is_turn_forbidden<'a>(
        restrictions: impl IntoIterator<Item = &'a TurnRestriction>,
        from_lon: i32,
        from_lat: i32,
        to_lon: i32,
        to_lat: i32,
        bike_mode: bool,
        car_mode: bool,
    ) -> bool {
        let mut has_any_positive = false;
        let mut has_positive = false;
        let mut has_negative = false;
        for tr in restrictions {
            if (tr.except_bikes() && bike_mode) || (tr.except_motorcars() && car_mode) {
                continue;
            }
            if tr.from_lon == from_lon && tr.from_lat == from_lat {
                if tr.is_positive {
                    has_any_positive = true;
                }
                if tr.to_lon == to_lon && tr.to_lat == to_lat {
                    if tr.is_positive {
                        has_positive = true;
                    } else {
                        has_negative = true;
                    }
                }
            }
        }
        !has_positive && (has_any_positive || has_negative)
    }
}

/// Port of `OsmNode`. Java's `OsmNode` extends `OsmLink`, so every node carries a link of its own that
/// the decoder reuses for one of the node's links (and the router reads, e.g. `KinematicPrePath` uses
/// `targetNode.descriptionBitmap`); here that link is `own_link()`, allocated with the node.
#[derive(Clone, Debug)]
pub struct OsmNode {
    pub ilat: i32,
    pub ilon: i32,
    /// Elevation in quarter meters; `i16::MIN` if unknown, -12345 while hollow.
    pub selev: i16,
    pub node_description: Option<Description>,
    pub first_restriction: Option<RestrictionIdx>,
    pub visit_id: i32,
    /// Head of the node's link chain; follow it with `OsmLink::next(node)`.
    pub firstlink: Option<LinkIdx>,
    own_link: LinkIdx,
}

impl OsmNode {
    pub fn is_hollow(&self) -> bool {
        self.selev == HOLLOW_SELEV
    }

    pub fn own_link(&self) -> LinkIdx {
        self.own_link
    }
}

impl OsmPos for OsmNode {
    fn ilon(&self) -> i32 {
        self.ilon
    }
    fn ilat(&self) -> i32 {
        self.ilat
    }
    fn selev(&self) -> i16 {
        self.selev
    }
}

/// Stored for "no link holder", so a link needs 4 bytes per direction instead of 8.
const NO_HOLDER: u32 = u32::MAX;

/// Port of `OsmLink`: a way section between two nodes, valid in both directions until one is cleared.
/// `n1 -> n2` is the forward direction. `previous` links the chain of `n2` (the reverse direction),
/// `next` the chain of `n1`.
#[derive(Clone, Debug)]
pub struct OsmLink {
    /// The way tags (valid for both directions).
    pub description_bitmap: Option<Description>,
    /// Intermediate nodes in forward direction, `None` for none (see `GeometryDecoder`).
    pub geometry: Option<Rc<[u8]>>,
    n1: Option<NodeIdx>,
    n2: Option<NodeIdx>,
    previous: Option<LinkIdx>,
    next: Option<LinkIdx>,
    reverse_link_holder: u32,
    first_link_holder: u32,
}

impl Default for OsmLink {
    fn default() -> Self {
        Self {
            description_bitmap: None,
            geometry: None,
            n1: None,
            n2: None,
            previous: None,
            next: None,
            reverse_link_holder: NO_HOLDER,
            first_link_holder: NO_HOLDER,
        }
    }
}

impl OsmLink {
    /// `n2` unless it is `source` or cleared, else `n1`. For a link in `source`'s chain this is always
    /// the other node; Java passes `null` for the router's start link.
    pub fn target(&self, source: impl Into<Option<NodeIdx>>) -> Option<NodeIdx> {
        let source = source.into();
        if self.n2 != source && self.n2.is_some() { self.n2 } else { self.n1 }
    }

    /// The next link in `source`'s chain.
    pub fn next(&self, source: impl Into<Option<NodeIdx>>) -> Option<LinkIdx> {
        let source = source.into();
        if self.n2 != source && self.n2.is_some() { self.next } else { self.previous }
    }

    /// True if walking from `source` runs against the way's direction.
    pub fn is_reverse(&self, source: impl Into<Option<NodeIdx>>) -> bool {
        let source = source.into();
        self.n1 != source && self.n1.is_some()
    }

    pub fn is_bidirectional(&self) -> bool {
        self.n1.is_some() && self.n2.is_some()
    }

    pub fn is_link_unused(&self) -> bool {
        self.n1.is_none() && self.n2.is_none()
    }

    /// Whether the direction leaving `source` is the forward one (`n1 -> n2`), checked in Java's
    /// order. Panics with Java's internal-error message if `source` has no direction on this link.
    fn leaves_forward(&self, source: Option<NodeIdx>, what: &str) -> bool {
        if self.n2.is_some() && self.n2 != source {
            true
        } else if self.n1.is_some() && self.n1 != source {
            false
        } else {
            panic!("internal error: {what}: unknown source");
        }
    }

    /// Resets this link for the direction leaving `source`; returns that direction's next link.
    fn clear(&mut self, source: NodeIdx) -> Option<LinkIdx> {
        let n = if self.leaves_forward(Some(source), "setNext") {
            self.n2 = None;
            self.first_link_holder = NO_HOLDER;
            self.next.take()
        } else {
            self.n1 = None;
            self.reverse_link_holder = NO_HOLDER;
            self.previous.take()
        };
        if self.n1.is_none() && self.n2.is_none() {
            self.description_bitmap = None;
            self.geometry = None;
        }
        n
    }

    /// The first router path stored for the direction leaving `source` (Java: `getFirstLinkHolder`).
    pub fn first_link_holder(&self, source: impl Into<Option<NodeIdx>>) -> Option<u32> {
        let holder = if self.leaves_forward(source.into(), "getFirstLinkHolder") {
            self.first_link_holder
        } else {
            self.reverse_link_holder
        };
        (holder != NO_HOLDER).then_some(holder)
    }

    /// Router path handles must be below `u32::MAX`.
    pub fn set_first_link_holder(&mut self, holder: Option<u32>, source: impl Into<Option<NodeIdx>>) {
        let holder = holder.map_or(NO_HOLDER, |h| {
            assert_ne!(h, NO_HOLDER, "link holder handle u32::MAX is reserved");
            h
        });
        if self.leaves_forward(source.into(), "setFirstLinkHolder") {
            self.first_link_holder = holder;
        } else {
            self.reverse_link_holder = holder;
        }
    }

    /// `addLinkHolder`: makes `holder` the first path for the direction leaving `source` and returns
    /// the previous first one. The caller must then do what Java's `holder.setNextForLink(previous)`
    /// does: store the returned handle as `holder`'s next path, if there is one.
    #[must_use = "the previous holder must become the new holder's next_for_link"]
    pub fn add_link_holder(&mut self, holder: u32, source: impl Into<Option<NodeIdx>>) -> Option<u32> {
        let source = source.into();
        let first_holder = self.first_link_holder(source);
        self.set_first_link_holder(Some(holder), source);
        first_holder
    }
}

/// One level of `minVisitIdInSubtree`'s recursion.
struct SubtreeFrame {
    source: Option<NodeIdx>,
    n: NodeIdx,
    next_link: Option<LinkIdx>,
    min_id: i32,
    /// The link and child being descended into, with `nodesCreated` before the descent.
    pending: Option<(LinkIdx, NodeIdx, i32)>,
}

/// Port of `OsmNodesMap`: owns the graph (node, link and turn-restriction arenas), the index of hollow
/// nodes by position, and the router-facing state used by the decoder and the memory checks.
pub struct OsmNodesMap {
    nodes: Vec<OsmNode>,
    links: Vec<OsmLink>,
    restrictions: Vec<TurnRestriction>,
    hmap: NodeHashMap,
    ab_unifier: ByteArrayCache,

    pub nodes_created: i32,
    pub maxmem: i64,
    currentmaxmem: i64,
    pub last_visit_id: i32,
    pub base_id: i32,

    /// Position of the search target (Java: an `OsmNodeNamed`), for `collect_outreachers`.
    pub destination: Option<crate::Pos>,
    pub current_path_cost: i32,
    pub current_max_cost: i32,

    /// End nodes stay in the index even when loaded (needed for escape analysis).
    pub end_node1: Option<NodeIdx>,
    pub end_node2: Option<NodeIdx>,

    /// 0 = just count, 1 = remove peninsulas, 2 = tree mode (`cleanupAndCount`).
    pub cleanup_mode: i32,

    nodes2check: Vec<NodeIdx>,
    subtree_stack: Vec<SubtreeFrame>,
}

impl Default for OsmNodesMap {
    fn default() -> Self {
        Self::new()
    }
}

impl OsmNodesMap {
    pub fn new() -> Self {
        Self {
            nodes: Vec::new(),
            links: Vec::new(),
            restrictions: Vec::new(),
            hmap: NodeHashMap::new(),
            ab_unifier: ByteArrayCache::new(16_384),
            nodes_created: 0,
            maxmem: 0,
            currentmaxmem: 4_000_000, // start with 4 MB
            last_visit_id: 1000,
            base_id: 1000,
            destination: None,
            current_path_cost: 0,
            current_max_cost: 1_000_000_000,
            end_node1: None,
            end_node2: None,
            cleanup_mode: 0,
            nodes2check: Vec::new(),
            subtree_stack: Vec::new(),
        }
    }

    /// `new OsmNode(ilon, ilat)`: a node with unknown elevation, not yet in the index.
    pub fn create_node(&mut self, ilon: i32, ilat: i32) -> NodeIdx {
        let own_link = self.create_link(None, None);
        let idx = NodeIdx::from_index(self.nodes.len());
        self.nodes.push(OsmNode {
            ilat,
            ilon,
            selev: i16::MIN,
            node_description: None,
            first_restriction: None,
            visit_id: 0,
            firstlink: None,
            own_link,
        });
        idx
    }

    /// `new OsmLink(source, target)`, e.g. the router's start link `(None, start_node)`. Not part of any
    /// node's chain.
    pub fn create_link(&mut self, source: Option<NodeIdx>, target: Option<NodeIdx>) -> LinkIdx {
        let idx = LinkIdx::from_index(self.links.len());
        self.links.push(OsmLink { n1: source, n2: target, ..OsmLink::default() });
        idx
    }

    pub fn node(&self, n: NodeIdx) -> &OsmNode {
        &self.nodes[n.index()]
    }

    pub fn node_mut(&mut self, n: NodeIdx) -> &mut OsmNode {
        &mut self.nodes[n.index()]
    }

    pub fn link(&self, l: LinkIdx) -> &OsmLink {
        &self.links[l.index()]
    }

    pub fn link_mut(&mut self, l: LinkIdx) -> &mut OsmLink {
        &mut self.links[l.index()]
    }

    /// Number of nodes ever created in this map (the arena never shrinks).
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// The target of `link` seen from `source`, which must be one of its nodes.
    pub fn target(&self, link: LinkIdx, source: NodeIdx) -> NodeIdx {
        self.link(link).target(source).expect("link in the source's chain has a target")
    }

    /// The next link after `link` in `source`'s chain.
    pub fn next_link(&self, link: LinkIdx, source: NodeIdx) -> Option<LinkIdx> {
        self.link(link).next(source)
    }

    /// The links in `n`'s chain, for read-only walks (loops that change the graph need `next_link`).
    pub fn links(&self, n: NodeIdx) -> impl Iterator<Item = LinkIdx> + '_ {
        std::iter::successors(self.node(n).firstlink, move |&l| self.next_link(l, n))
    }

    /// The link the decoder uses for a new link between two nodes: `node`'s own link if unused, else
    /// `node2`'s, else a new one (`DirectWeaver`).
    pub fn reusable_link(&mut self, node: NodeIdx, node2: NodeIdx) -> LinkIdx {
        let own1 = self.node(node).own_link;
        let own2 = self.node(node2).own_link;
        if self.link(own1).is_link_unused() {
            own1
        } else if self.link(own2).is_link_unused() {
            own2
        } else {
            self.create_link(None, None)
        }
    }

    /// The indexed node at this position (hollow nodes and the end nodes).
    pub fn get(&self, ilon: i32, ilat: i32) -> Option<NodeIdx> {
        self.hmap.get(ilon, ilat)
    }

    /// Indexes `node` by its position; returns the node previously indexed there.
    pub fn put(&mut self, node: NodeIdx) -> Option<NodeIdx> {
        let n = &self.nodes[node.index()];
        self.hmap.put(n.ilon, n.ilat, node)
    }

    /// Removes whatever node is indexed at `node`'s position, unless `node` is an end node.
    pub fn remove(&mut self, node: NodeIdx) {
        if Some(node) != self.end_node1 && Some(node) != self.end_node2 {
            let n = &self.nodes[node.index()];
            self.hmap.remove(n.ilon, n.ilat);
        }
    }

    /// The indexed nodes in Java's `HashMap` iteration order.
    pub fn indexed_nodes(&self) -> impl Iterator<Item = NodeIdx> + '_ {
        self.hmap.values()
    }

    /// Insertions into index buckets that already held 8 entries, where Java's `HashMap` switches to a
    /// tree (see `node_hash`). While this is 0, the index iterates exactly like Java's.
    pub fn treeified_buckets(&self) -> usize {
        self.hmap.treeified_buckets
    }

    pub fn byte_array_unifier(&mut self) -> &mut ByteArrayCache {
        &mut self.ab_unifier
    }

    pub fn is_hollow(&self, n: NodeIdx) -> bool {
        self.node(n).is_hollow()
    }

    pub fn set_hollow(&mut self, n: NodeIdx) {
        self.node_mut(n).selev = HOLLOW_SELEV;
    }

    pub fn id_from_pos(&self, n: NodeIdx) -> i64 {
        self.node(n).id_from_pos()
    }

    /// Prepends a turn restriction to the node's list (`addTurnRestriction`).
    pub fn add_turn_restriction(&mut self, node: NodeIdx, mut tr: TurnRestriction) {
        tr.next = self.node(node).first_restriction;
        let idx = RestrictionIdx::from_index(self.restrictions.len());
        self.restrictions.push(tr);
        self.node_mut(node).first_restriction = Some(idx);
    }

    /// The node's turn restrictions, newest first like Java's list.
    pub fn restrictions(&self, node: NodeIdx) -> impl Iterator<Item = &TurnRestriction> + '_ {
        std::iter::successors(self.node(node).first_restriction.map(|i| &self.restrictions[i.index()]), |tr| {
            tr.next.map(|i| &self.restrictions[i.index()])
        })
    }

    /// `addLink(link, isReverse, tn)`: puts `link` at the head of both nodes' chains.
    pub fn add_link(&mut self, node: NodeIdx, link: LinkIdx, is_reverse: bool, tn: NodeIdx) {
        let firstlink = self.node(node).firstlink;
        if Some(link) == firstlink {
            panic!("UUUUPS");
        }
        let tn_firstlink = self.node(tn).firstlink;
        let l = self.link_mut(link);
        if is_reverse {
            l.n1 = Some(tn);
            l.n2 = Some(node);
            l.next = tn_firstlink;
            l.previous = firstlink;
        } else {
            l.n1 = Some(node);
            l.n2 = Some(tn);
            l.next = firstlink;
            l.previous = tn_firstlink;
        }
        self.node_mut(tn).firstlink = Some(link);
        self.node_mut(node).firstlink = Some(link);
    }

    /// `addLink(linklon, linklat, description, geometry, hollowNodes, isReverse)`: links `node` to the
    /// node at the given position, reusing a matching link or target and creating a hollow target node
    /// if none is known.
    pub fn add_link_to(
        &mut self,
        node: NodeIdx,
        linklon: i32,
        linklat: i32,
        description: Option<Description>,
        geometry: Option<Rc<[u8]>>,
        is_reverse: bool,
    ) {
        let (ilon, ilat) = (self.node(node).ilon, self.node(node).ilat);
        if linklon == ilon && linklat == ilat {
            return; // skip self-ref
        }

        let mut tn = None; // find the target node
        let mut link = None;

        // ...in our known links
        let mut l = self.node(node).firstlink;
        while let Some(li) = l {
            let t = self.target(li, node);
            let tnode = self.node(t);
            if tnode.ilon == linklon && tnode.ilat == linklat {
                tn = Some(t);
                let ol = self.link(li);
                if is_reverse || (ol.description_bitmap.is_none() && !ol.is_reverse(node)) {
                    link = Some(li); // the correct one that needs our data
                    break;
                }
            }
            l = self.next_link(li, node);
        }
        // .. not found, then check the hollow nodes
        let tn = match tn.or_else(|| self.get(linklon, linklat)) {
            Some(tn) => tn,
            None => {
                // node not yet known, create a new hollow proxy
                let tn = self.create_node(linklon, linklat);
                self.set_hollow(tn);
                self.put(tn);
                let own = self.node(tn).own_link;
                link = Some(own);
                self.add_link(node, own, is_reverse, tn); // technical inheritance: link instance in node
                tn
            }
        };
        let link = match link {
            Some(link) => link,
            None => {
                let link = self.create_link(None, None);
                self.add_link(node, link, is_reverse, tn);
                link
            }
        };
        if !is_reverse {
            let l = self.link_mut(link);
            l.description_bitmap = description;
            l.geometry = geometry;
        }
    }

    /// `unlinkLink`: clears the direction of `link` leaving `node` and removes it from `node`'s chain.
    pub fn unlink_link(&mut self, node: NodeIdx, link: LinkIdx) {
        let n = self.link_mut(link).clear(node);

        if Some(link) == self.node(node).firstlink {
            self.node_mut(node).firstlink = n;
            return;
        }
        let mut l = self.node(node).firstlink;
        while let Some(li) = l {
            let ol = self.link(li);
            if ol.n1 != Some(node) && ol.n1.is_some() {
                // isReverse inline
                let nl = ol.previous;
                if nl == Some(link) {
                    self.link_mut(li).previous = n;
                    return;
                }
                l = nl;
            } else if ol.n2 != Some(node) && ol.n2.is_some() {
                let nl = ol.next;
                if nl == Some(link) {
                    self.link_mut(li).next = n;
                    return;
                }
                l = nl;
            } else {
                panic!("unlinkLink: unknown source");
            }
        }
    }

    /// `vanish`: removes all links between a loaded node and its loaded neighbours.
    pub fn vanish(&mut self, node: NodeIdx) {
        if self.is_hollow(node) {
            return;
        }
        let mut l = self.node(node).firstlink;
        while let Some(li) = l {
            let target = self.target(li, node);
            let next_link = self.next_link(li, node);
            if !self.is_hollow(target) {
                self.unlink_link(node, li);
                if !self.link(li).is_link_unused() {
                    self.unlink_link(target, li);
                }
            }
            l = next_link;
        }
    }

    /// `parseNodeBody2`: fills a hollow node from its body in a `MicroCache` (`MicroCache::get_and_clear`).
    /// Node descriptions are unified through this map, way descriptions through `exp_ctx_way`.
    pub fn parse_node_body2(&mut self, node: NodeIdx, mc: &mut ByteDataReader, exp_ctx_way: &mut dyn ByteArrayUnifier) {
        // read turn restrictions
        while mc.read_boolean() {
            let exceptions = mc.read_short();
            let is_positive = mc.read_boolean();
            let from_lon = mc.read_int();
            let from_lat = mc.read_int();
            let to_lon = mc.read_int();
            let to_lat = mc.read_int();
            self.add_turn_restriction(
                node,
                TurnRestriction::new(is_positive, exceptions, from_lon, from_lat, to_lon, to_lat),
            );
        }

        let selev = mc.read_short();
        let node_desc_size = mc.read_var_length_unsigned();
        let node_description = (node_desc_size != 0).then(|| {
            let len = node_desc_size as usize;
            self.ab_unifier.unify(mc.read_bytes(len), 0, len)
        });
        let (ilon, ilat) = {
            let n = self.node_mut(node);
            n.selev = selev;
            n.node_description = node_description;
            (n.ilon, n.ilat)
        };

        while mc.has_more_data() {
            // read link data
            let end_pointer = mc.get_end_pointer();
            let linklon = ilon.wrapping_add(mc.read_var_length_signed());
            let linklat = ilat.wrapping_add(mc.read_var_length_signed());
            let sizecode = mc.read_var_length_unsigned();
            let is_reverse = sizecode & 1 != 0;
            let desc_size = sizecode >> 1;
            let description = (desc_size > 0).then(|| {
                let len = desc_size as usize;
                exp_ctx_way.unify(mc.read_bytes(len), 0, len)
            });
            let geometry = mc.read_data_until(end_pointer).map(Rc::from);

            self.add_link_to(node, linklon, linklat, description, geometry, is_reverse);
        }
        self.remove(node);
    }

    /// Called by the decoder with the nodes of a freshly woven cell.
    pub fn cleanup_and_count(&mut self, nodes: &[NodeIdx]) {
        if self.cleanup_mode == 0 {
            self.just_count(nodes);
        } else {
            self.cleanup_peninsulas(nodes);
        }
    }

    fn just_count(&mut self, nodes: &[NodeIdx]) {
        for &n in nodes {
            if self.node(n).firstlink.is_some() {
                self.nodes_created += 1;
            }
        }
    }

    fn cleanup_peninsulas(&mut self, nodes: &[NodeIdx]) {
        self.base_id = self.last_visit_id;
        self.last_visit_id += 1;
        for &n in nodes {
            // loop over nodes again just for housekeeping
            if self.node(n).firstlink.is_some() && self.node(n).visit_id == 1 {
                self.min_visit_id_in_subtree(n);
            }
        }
    }

    /// `minVisitIdInSubtree`, recursive in Java, here with an explicit stack in the same order. Java
    /// catches a `StackOverflowError` and leaves the subtree half processed; a JVM-dependent depth this
    /// port cannot reproduce, so it always completes.
    fn min_visit_id_in_subtree(&mut self, n: NodeIdx) {
        let mut stack = std::mem::take(&mut self.subtree_stack);
        stack.push(self.enter_subtree(None, n));
        let mut child_result: Option<i32> = None;
        loop {
            let top = stack.len() - 1;
            let n = stack[top].n;
            if let Some(min_id_sub) = child_result.take() {
                let (l, t, nodes_created_until_here) = stack[top].pending.take().expect("pending descent");
                if min_id_sub > self.node(n).visit_id {
                    // peninsula?
                    self.nodes_created = nodes_created_until_here;
                    self.unlink_link(n, l);
                    self.unlink_link(t, l);
                }
                if min_id_sub < stack[top].min_id {
                    stack[top].min_id = min_id_sub;
                }
            }

            let mut descend = None;
            while let Some(l) = stack[top].next_link {
                stack[top].next_link = self.next_link(l, n);

                let t = self.target(l, n);
                if Some(t) == stack[top].source || self.is_hollow(t) {
                    continue;
                }

                let mut min_id_sub = self.node(t).visit_id;
                if min_id_sub == 1 {
                    min_id_sub = self.base_id;
                } else if min_id_sub == 0 {
                    stack[top].pending = Some((l, t, self.nodes_created));
                    descend = Some(t);
                    break;
                } else if min_id_sub < self.base_id {
                    continue;
                } else if self.cleanup_mode == 2 {
                    min_id_sub = self.base_id; // in tree-mode, hitting anything is like a gateway
                }
                if min_id_sub < stack[top].min_id {
                    stack[top].min_id = min_id_sub;
                }
            }
            if let Some(t) = descend {
                let frame = self.enter_subtree(Some(n), t);
                stack.push(frame);
                continue;
            }
            let done = stack.pop().expect("frame");
            if stack.is_empty() {
                self.subtree_stack = stack; // keep the allocation for the next cell
                return;
            }
            child_result = Some(done.min_id);
        }
    }

    /// The entry of `minVisitIdInSubtree`: assigns the visit id and counts the node.
    fn enter_subtree(&mut self, source: Option<NodeIdx>, n: NodeIdx) -> SubtreeFrame {
        let visit_id = if self.node(n).visit_id == 1 {
            self.base_id // border node
        } else {
            let id = self.last_visit_id;
            self.last_visit_id += 1;
            id
        };
        self.node_mut(n).visit_id = visit_id;
        self.nodes_created += 1;
        SubtreeFrame { source, n, next_link: self.node(n).firstlink, min_id: visit_id, pending: None }
    }

    /// Estimated memory use against the limit; with `extend`, raises the limit towards `maxmem`.
    pub fn is_in_memory_bounds(&mut self, npaths: i32, extend: bool) -> bool {
        let mut total = i64::from(self.nodes_created) * 95 + i64::from(npaths) * 200;

        if extend {
            total += 100_000;

            // when extending, try to have 1 MB space
            let delta = total + 1_900_000 - self.currentmaxmem;
            if delta > 0 {
                self.currentmaxmem += delta;
                if self.currentmaxmem > self.maxmem {
                    self.currentmaxmem = self.maxmem;
                }
            }
        }
        total <= self.currentmaxmem
    }

    /// Is there an escape from this node to a hollow node (or destination node)? Vanishes the node's
    /// component if not. Use after `collect_outreachers`.
    pub fn can_escape(&mut self, n0: NodeIdx) -> bool {
        let mut saw_low_ids = false;
        self.last_visit_id += 1;
        self.nodes2check.clear();
        self.nodes2check.push(n0);
        while let Some(n) = self.nodes2check.pop() {
            let visit_id = self.node(n).visit_id;
            if visit_id < self.base_id {
                self.node_mut(n).visit_id = self.last_visit_id;
                self.nodes_created += 1;
                self.push_link_targets(n);
            } else if visit_id < self.last_visit_id {
                saw_low_ids = true;
            }
        }
        if saw_low_ids {
            return true;
        }

        self.nodes2check.push(n0);
        while let Some(n) = self.nodes2check.pop() {
            if self.node(n).visit_id == self.last_visit_id {
                self.nodes_created -= 1;
                self.push_link_targets(n);
                self.vanish(n);
            }
        }

        false
    }

    fn push_link_targets(&mut self, n: NodeIdx) {
        let mut l = self.node(n).firstlink;
        while let Some(li) = l {
            let t = self.target(li, n);
            self.nodes2check.push(t);
            l = self.next_link(li, n);
        }
    }

    fn add_active_node(&mut self, n: NodeIdx) {
        self.node_mut(n).visit_id = self.last_visit_id;
        self.nodes_created += 1;
        self.nodes2check.push(n);
    }

    pub fn clear_temp(&mut self) {
        self.nodes2check = Vec::new();
    }

    /// Marks everything reachable from the hollow nodes, vanishing nodes too far from the destination
    /// for the remaining cost budget, and recounts `nodes_created`. Fails like Java's
    /// `new ArrayList<>(nodesCreated)` if `nodes_created` went negative.
    pub fn collect_outreachers(&mut self) -> Result<(), MapError> {
        let capacity = usize::try_from(self.nodes_created)
            .map_err(|_| MapError::IllegalArgument(format!("Illegal Capacity: {}", self.nodes_created)))?;
        self.nodes2check = Vec::with_capacity(capacity);
        self.nodes_created = 0;
        for n in self.hmap.values() {
            // addActiveNode, with the fields borrowed apart from the index
            self.nodes[n.index()].visit_id = self.last_visit_id;
            self.nodes_created += 1;
            self.nodes2check.push(n);
        }

        self.last_visit_id += 1;
        self.base_id = self.last_visit_id;

        while let Some(n) = self.nodes2check.pop() {
            self.node_mut(n).visit_id = self.last_visit_id;

            let mut l = self.node(n).firstlink;
            while let Some(li) = l {
                let t = self.target(li, n);
                if self.node(t).visit_id != self.last_visit_id {
                    self.add_active_node(t);
                }
                l = self.next_link(li, n);
            }
            if let Some(destination) = self.destination
                && self.current_max_cost < 1_000_000_000
            {
                let distance = self.node(n).calc_distance(&destination);
                if distance > self.current_max_cost - self.current_path_cost + 100 {
                    self.vanish(n);
                }
            }
            if self.node(n).firstlink.is_none() {
                self.nodes_created -= 1;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Java's `OsmNodesMap.main`: peninsula cleanup in tree mode on a small graph.
    #[test]
    fn cleanup_matches_java_main() {
        let mut nm = OsmNodesMap::new();
        let nodes: Vec<NodeIdx> = (0..12).map(|i| nm.create_node((i + 1000) * 1000, (i + 1000) * 1000)).collect();
        let add_links = |nm: &mut OsmNodesMap, idx: usize, is_border: bool, links: &[usize]| {
            let n = nodes[idx];
            nm.node_mut(n).visit_id = if is_border { 1 } else { 0 };
            nm.node_mut(n).selev = idx as i16;
            for &i in links {
                let t = nodes[i];
                let link = nm.reusable_link(n, t);
                nm.add_link(n, link, false, t);
            }
        };
        add_links(&mut nm, 0, true, &[1, 5]);
        add_links(&mut nm, 1, true, &[]);
        add_links(&mut nm, 2, false, &[3, 4]);
        add_links(&mut nm, 3, false, &[4]);
        add_links(&mut nm, 4, false, &[]);
        add_links(&mut nm, 5, true, &[6, 9]);
        add_links(&mut nm, 6, false, &[7, 8]);
        add_links(&mut nm, 7, false, &[]);
        add_links(&mut nm, 8, false, &[]);
        add_links(&mut nm, 9, false, &[10, 11]);
        add_links(&mut nm, 10, false, &[11]);
        add_links(&mut nm, 11, false, &[]);

        nm.cleanup_mode = 2;
        nm.cleanup_and_count(&nodes);
        // Java prints nodesCreated=6 twice.
        assert_eq!(nm.nodes_created, 6);
        nm.cleanup_and_count(&nodes);
        assert_eq!(nm.nodes_created, 6);
        // The peninsula 5-6-7-8 hangs off border node 5; 6 lost its link to 5.
        let six_targets: Vec<_> = nm.links(nodes[6]).map(|l| nm.target(l, nodes[6])).collect();
        assert!(!six_targets.contains(&nodes[5]));
    }

    #[test]
    fn collect_outreachers_fails_like_java_on_negative_count() {
        let mut nm = OsmNodesMap::new();
        nm.nodes_created = -5;
        assert_eq!(nm.collect_outreachers(), Err(MapError::IllegalArgument("Illegal Capacity: -5".into())));
    }

    #[test]
    fn link_directions_and_unlink() {
        let mut nm = OsmNodesMap::new();
        let a = nm.create_node(1, 1);
        let b = nm.create_node(2, 2);
        let c = nm.create_node(3, 3);
        let ab = nm.node(a).own_link();
        nm.add_link(a, ab, false, b);
        let ac = nm.node(c).own_link();
        nm.add_link(a, ac, true, c);
        assert_eq!(nm.node(a).firstlink, Some(ac));
        assert_eq!(nm.next_link(ac, a), Some(ab));
        assert!(nm.link(ac).is_reverse(a));
        assert!(!nm.link(ab).is_reverse(a));
        assert_eq!(nm.target(ab, b), a);

        nm.unlink_link(a, ab);
        assert_eq!(nm.next_link(ac, a), None);
        assert!(!nm.link(ab).is_bidirectional());
        // b still reaches a against the link's direction
        assert_eq!(nm.node(b).firstlink, Some(ab));
        assert_eq!(nm.target(ab, b), a);
        nm.unlink_link(b, ab);
        assert!(nm.link(ab).is_link_unused());
        assert_eq!(nm.node(b).firstlink, None);
    }
}

//! Port of the parts of `OsmTrack` the router uses: the node list with its position map (for the
//! reference-track penalty and the cost-cutting match), appending segments, the totals and the
//! aggregated message table.
//!
//! The detour map stays empty without turn instructions (`turnInstructionMode` 0), and so do the
//! voice hints, which are left out. Elements live in the request's `PathElements`, so the methods that
//! read or change them take the arena.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

use brouter_mapaccess::OsmPos;

use crate::path_element::{ElemIdx, OsmPathElement, PathElements};

pub struct OsmTrack {
    pub nodes: Vec<ElemIdx>,
    /// `nodesMap`: elements by position id, in track order (Java's `OsmPathElementHolder` chains).
    nodes_map: Option<HashMap<i64, Vec<ElemIdx>, BuildHasherDefault<IdHasher>>>,

    pub distance: i32,
    pub ascend: i32,
    pub plain_ascend: i32,
    pub cost: i32,
    pub energy: i32,

    pub name: String,
    pub showspeed: bool,
}

impl Default for OsmTrack {
    fn default() -> Self {
        Self {
            nodes: Vec::new(),
            nodes_map: None,
            distance: 0,
            ascend: 0,
            plain_ascend: 0,
            cost: 0,
            energy: 0,
            name: "unset".to_string(),
            showspeed: false,
        }
    }
}

impl OsmTrack {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn build_map(&mut self, elements: &PathElements) {
        let mut map: HashMap<i64, Vec<ElemIdx>, _> =
            HashMap::with_capacity_and_hasher(self.nodes.len(), BuildHasherDefault::default());
        for &node in &self.nodes {
            map.entry(elements[node].id_from_pos()).or_default().push(node);
        }
        self.nodes_map = Some(map);
    }

    /// `addNodes`: prepends `t`'s nodes one by one (so in reverse order) and rebuilds the map.
    pub fn add_nodes(&mut self, t: &OsmTrack, elements: &PathElements) {
        self.nodes.splice(0..0, t.nodes.iter().rev().copied());
        self.build_map(elements);
    }

    pub fn contains_node(&self, id: i64) -> bool {
        self.nodes_map.as_ref().is_some_and(|m| m.contains_key(&id))
    }

    /// The track element at `n2` reached from `n1`.
    pub fn get_link(&self, n1: i64, n2: i64, elements: &PathElements) -> Option<ElemIdx> {
        let holders = self.nodes_map.as_ref()?.get(&n2)?;
        holders.iter().copied().find(|&h| elements[h].origin.is_some_and(|o| elements[o].id_from_pos() == n1))
    }

    /// `appendTrack`: appends `t` (its first node is this track's last), shifting its times, energies
    /// and costs by this track's totals.
    pub fn append_track(&mut self, t: &OsmTrack, elements: &mut PathElements) {
        let our_size = self.nodes.len();
        let last = self.nodes.last().copied();
        if let Some(olde) = last
            && t.nodes.len() > 1
        {
            elements[t.nodes[1]].origin = Some(olde);
        }
        let (t0, e0, c0) = last.map_or((0.0, 0.0, 0), |l| (elements[l].time(), elements[l].energy(), elements[l].cost));
        for (i, &e) in t.nodes.iter().enumerate() {
            if i == 0
                && let Some(l) = last
                && elements[l].selev == i16::MIN
            {
                elements[l].selev = elements[e].selev;
            }
            if i > 0 || our_size == 0 {
                let element = &mut elements[e];
                element.set_time(element.time() + t0);
                element.set_energy(element.energy() + e0);
                element.cost = element.cost.wrapping_add(c0);
                let (ilon, ilat) = (element.ilon, element.ilat);
                if let Some(m) = &mut element.message {
                    m.lon = ilon;
                    m.lat = ilat;
                }
                self.nodes.push(e);
            }
        }
        self.distance = self.distance.wrapping_add(t.distance);
        self.ascend = self.ascend.wrapping_add(t.ascend);
        self.plain_ascend = self.plain_ascend.wrapping_add(t.plain_ascend);
        self.cost = self.cost.wrapping_add(t.cost);
        self.energy = elements[*self.nodes.last().expect("appended at least one node")].energy() as i32;
        self.showspeed |= t.showspeed;
    }

    /// `aggregateMessages`: one table line per run of equal way tags, split at nodes with tags.
    pub fn aggregate_messages(&self, elements: &PathElements) -> Vec<String> {
        let mut res = Vec::new();
        let mut current: Option<crate::message_data::MessageData> = None;
        for &n in &self.nodes {
            let Some(m) = &elements[n].message else { continue };
            if m.way_key_values.is_none() {
                continue;
            }
            let mut md = (**m).clone();
            if let Some(cur) = &current {
                if cur.node_key_values.is_some() || cur.way_key_values != md.way_key_values {
                    res.extend(cur.to_message());
                } else {
                    md.add(cur);
                }
            }
            current = Some(md);
        }
        if let Some(cur) = current {
            res.extend(cur.to_message());
        }
        res
    }

    /// The track with its elements copied out of their arena, for another thread: its nodes and
    /// everything they lead back to through `origin`, with the links between them.
    pub fn detach(self, elements: &PathElements) -> DetachedTrack {
        let mut local: HashMap<ElemIdx, u32> = HashMap::new();
        let mut copied = Vec::new();
        for &node in &self.nodes {
            let mut e = Some(node);
            while let Some(idx) = e.filter(|idx| !local.contains_key(idx)) {
                local.insert(idx, copied.len() as u32);
                copied.push(idx);
                e = elements[idx].origin;
            }
        }
        let origins = copied.iter().map(|&idx| elements[idx].origin.map(|o| local[&o])).collect();
        let copies = copied.iter().map(|&idx| OsmPathElement { origin: None, ..elements[idx].clone() }).collect();
        let nodes = self.nodes.iter().map(|n| local[n]).collect();
        DetachedTrack {
            track: OsmTrack { nodes: Vec::new(), nodes_map: None, ..self },
            nodes,
            elements: copies,
            origins,
        }
    }

    /// A detached track, moved into `elements`.
    pub fn attach(detached: DetachedTrack, elements: &mut PathElements) -> OsmTrack {
        let DetachedTrack { mut track, nodes, elements: copies, origins } = detached;
        let moved: Vec<ElemIdx> = copies.into_iter().map(|e| elements.push(e)).collect();
        for (&idx, origin) in moved.iter().zip(origins) {
            elements[idx].origin = origin.map(|o| moved[o as usize]);
        }
        track.nodes = nodes.into_iter().map(|n| moved[n as usize]).collect();
        track.build_map(elements);
        track
    }

    pub fn total_seconds(&self, elements: &PathElements) -> i32 {
        let s = if self.nodes.len() < 2 {
            0.0
        } else {
            elements[self.nodes[self.nodes.len() - 1]].time() - elements[self.nodes[0]].time()
        };
        (f64::from(s) + 0.5) as i32
    }
}

/// See `OsmTrack::detach`.
pub struct DetachedTrack {
    /// The track without its nodes.
    track: OsmTrack,
    /// The nodes, as positions in `elements`.
    nodes: Vec<u32>,
    elements: Vec<OsmPathElement>,
    /// Each element's origin, as a position in `elements`.
    origins: Vec<Option<u32>>,
}

/// Hashes the position ids of the node map (`ilon << 32 | ilat`).
#[derive(Default)]
struct IdHasher(u64);

impl Hasher for IdHasher {
    fn write(&mut self, _: &[u8]) {
        unreachable!("only i64 keys");
    }

    fn write_i64(&mut self, id: i64) {
        self.0 = (id as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    }

    fn finish(&self) -> u64 {
        // the table picks buckets by the low bits, which the multiplication fills from `ilat` only
        self.0.rotate_left(26)
    }
}

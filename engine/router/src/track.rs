//! Port of the parts of `OsmTrack` the router uses: the node list with its position map (for the
//! reference-track penalty and the cost-cutting match), appending segments, the totals and the
//! aggregated message table.
//!
//! The detour map stays empty without turn instructions (`turnInstructionMode` 0), and so do the
//! voice hints, which are left out. Elements live in the request's `PathElements`, so the methods that
//! read or change them take the arena.

use brouter_mapaccess::OsmPos;
use brouter_util::{CompactLongMap, FrozenLongMap};

use crate::path_element::{ElemIdx, PathElements};

pub struct OsmTrack {
    pub nodes: Vec<ElemIdx>,
    /// `nodesMap`: element ids by position, in track order (Java's `OsmPathElementHolder` chains).
    nodes_map: Option<FrozenLongMap<Vec<ElemIdx>>>,

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
        let mut map: CompactLongMap<Vec<ElemIdx>> = CompactLongMap::new();
        for &node in &self.nodes {
            let id = elements[node].id_from_pos();
            match map.get_mut(id) {
                Some(holders) => holders.push(node),
                None => map.fast_put(id, vec![node]),
            }
        }
        self.nodes_map = Some(map.freeze());
    }

    /// `addNodes`: prepends `t`'s nodes one by one (so in reverse order) and rebuilds the map.
    pub fn add_nodes(&mut self, t: &OsmTrack, elements: &PathElements) {
        self.nodes.splice(0..0, t.nodes.iter().rev().copied());
        self.build_map(elements);
    }

    pub fn contains_node(&self, id: i64) -> bool {
        self.nodes_map.as_ref().is_some_and(|m| m.contains(id))
    }

    /// The track element at `n2` reached from `n1`.
    pub fn get_link(&self, n1: i64, n2: i64, elements: &PathElements) -> Option<ElemIdx> {
        let holders = self.nodes_map.as_ref()?.get(n2)?;
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

    pub fn total_seconds(&self, elements: &PathElements) -> i32 {
        let s = if self.nodes.len() < 2 {
            0.0
        } else {
            elements[self.nodes[self.nodes.len() - 1]].time() - elements[self.nodes[0]].time()
        };
        (f64::from(s) + 0.5) as i32
    }
}

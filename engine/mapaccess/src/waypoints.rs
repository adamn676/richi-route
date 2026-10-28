//! Ports of `MatchedWaypoint`, `WaypointMatcherImpl` and `OsmNodePairSet`.

use crate::Pos;
use brouter_codec::WaypointMatcher;
use brouter_util::{CheapAngleMeter, CompactLongMap, cheap_ruler, jmath};

/// Port of `MatchedWaypoint`: a waypoint and the way section it was matched to. Java's free-standing
/// `OsmNode`s are `Pos`es here; `None` stands for `null`.
#[derive(Clone, Debug, PartialEq)]
pub struct MatchedWaypoint {
    pub node1: Option<Pos>,
    pub node2: Option<Pos>,
    pub crosspoint: Option<Pos>,
    pub waypoint: Pos,
    pub correctedpoint: Option<Pos>,
    /// Waypoint name used in error messages.
    pub name: String,
    /// Distance in meters between waypoint and crosspoint.
    pub radius: f64,
    pub wpttype: i8,
    pub index_in_track: i32,
    pub direction_to_next: f64,
    pub direction_diff: f64,
    pub way_nearest: Vec<MatchedWaypoint>,
    pub has_update: bool,
}

impl MatchedWaypoint {
    /// Route next to this point.
    pub const WAYPOINT_TYPE_SHAPING: i8 = 1;
    /// Visit this point.
    pub const WAYPOINT_TYPE_MEETING: i8 = 2;
    /// From this point go direct to the next one (beeline routing).
    pub const WAYPOINT_TYPE_DIRECT: i8 = 3;

    pub fn new(waypoint: Pos, name: impl Into<String>) -> Self {
        Self {
            node1: None,
            node2: None,
            crosspoint: None,
            waypoint,
            correctedpoint: None,
            name: name.into(),
            radius: 0.,
            wpttype: Self::WAYPOINT_TYPE_SHAPING,
            index_in_track: 0,
            direction_to_next: -1.,
            direction_diff: 361.,
            way_nearest: Vec::new(),
            has_update: false,
        }
    }
}

const MAX_POINTS: usize = 5;

/// Port of `WaypointMatcherImpl`: fed by the decoder with the geometry of every way the profile allows,
/// it keeps the closest matches for each waypoint. It updates the caller's waypoints in place.
pub struct WaypointMatcherImpl<'a> {
    waypoints: &'a mut Vec<MatchedWaypoint>,
    island_pairs: &'a OsmNodePairSet,

    lon_start: i32,
    lat_start: i32,
    lon_target: i32,
    lat_target: i32,
    any_update: bool,
    lon_last: i32,
    lat_last: i32,
    use_as_start_way: bool,
    max_distance: f64,
    pub use_dynamic_range: bool,
}

impl<'a> WaypointMatcherImpl<'a> {
    /// A negative `max_distance` means "dynamic range": its absolute value, with the search widened
    /// until a match is found.
    pub fn new(
        waypoints: &'a mut Vec<MatchedWaypoint>,
        mut max_distance: f64,
        island_pairs: &'a OsmNodePairSet,
    ) -> Self {
        let mut use_dynamic_range = false;
        if max_distance < 0. {
            max_distance *= -1.;
            use_dynamic_range = true;
        }

        let n = waypoints.len();
        for i in 0..n {
            waypoints[i].radius = max_distance;
            if i > 0 && waypoints[i].direction_to_next == -1. {
                let (last, mwp) = (waypoints[i - 1].waypoint, waypoints[i].waypoint);
                waypoints[i - 1].direction_to_next =
                    CheapAngleMeter::get_direction(last.ilon, last.ilat, mwp.ilon, mwp.ilat);
            }
        }
        // last point has no angle so we are looking back
        if n == 1 {
            waypoints[0].direction_to_next = -1.;
        } else if n > 1 {
            let (last, prev) = (waypoints[n - 1].waypoint, waypoints[n - 2].waypoint);
            waypoints[n - 1].direction_to_next =
                CheapAngleMeter::get_direction(last.ilon, last.ilat, prev.ilon, prev.ilat);
        }

        Self {
            waypoints,
            island_pairs,
            lon_start: 0,
            lat_start: 0,
            lon_target: 0,
            lat_target: 0,
            any_update: false,
            lon_last: 0,
            lat_last: 0,
            use_as_start_way: true,
            max_distance,
            use_dynamic_range,
        }
    }

    pub fn waypoints(&self) -> &[MatchedWaypoint] {
        self.waypoints
    }

    fn check_segment(&mut self, lon1: i32, lat1: i32, lon2: i32, lat2: i32) {
        let lonlat2m = cheap_ruler::get_lon_lat_to_meter_scales(lat1.wrapping_add(lat2) >> 1);
        let dlon2m = lonlat2m[0];
        let dlat2m = lonlat2m[1];

        let dx = f64::from(lon2.wrapping_sub(lon1)) * dlon2m;
        let dy = f64::from(lat2.wrapping_sub(lat1)) * dlat2m;
        let d = (dy * dy + dx * dx).sqrt();

        if d == 0. {
            return;
        }

        for i in 0..self.waypoints.len() {
            if !self.use_as_start_way && i == 0 {
                continue;
            }

            if self.waypoints[i].wpttype == MatchedWaypoint::WAYPOINT_TYPE_DIRECT
                && (i == 0 || self.waypoints[i - 1].wpttype == MatchedWaypoint::WAYPOINT_TYPE_DIRECT)
            {
                let mwp = &mut self.waypoints[i];
                if mwp.crosspoint.is_none() {
                    mwp.crosspoint = Some(mwp.waypoint);
                    mwp.has_update = true;
                    self.any_update = true;
                }
                continue;
            }

            let mwp = &mut self.waypoints[i];
            let wp = mwp.waypoint;
            let x1 = f64::from(lon1.wrapping_sub(wp.ilon)) * dlon2m;
            let y1 = f64::from(lat1.wrapping_sub(wp.ilat)) * dlat2m;
            let x2 = f64::from(lon2.wrapping_sub(wp.ilon)) * dlon2m;
            let y2 = f64::from(lat2.wrapping_sub(wp.ilat)) * dlat2m;
            let r12 = x1 * x1 + y1 * y1;
            let r22 = x2 * x2 + y2 * y2;
            let mut radius = (if r12 < r22 { y1 * dx - x1 * dy } else { y2 * dx - x2 * dy }).abs() / d;

            if radius <= mwp.radius {
                let mut s1 = x1 * dx + y1 * dy;
                let mut s2 = x2 * dx + y2 * dy;

                if s1 < 0. {
                    s1 = -s1;
                    s2 = -s2;
                }
                if s2 > 0. {
                    radius = (if s1 < s2 { r12 } else { r22 }).sqrt();

                    if radius > mwp.radius {
                        continue;
                    }
                }
                // new match for that waypoint
                mwp.radius = radius; // shortest distance to way
                mwp.has_update = true;
                self.any_update = true;
                // calculate crosspoint
                let crosspoint = mwp.crosspoint.get_or_insert_default();
                if s2 < 0. {
                    let wayfraction = -s2 / (d * d);
                    let xm = x2 - wayfraction * dx;
                    let ym = y2 - wayfraction * dy;
                    crosspoint.ilon = (xm / dlon2m + f64::from(wp.ilon)) as i32;
                    crosspoint.ilat = (ym / dlat2m + f64::from(wp.ilat)) as i32;
                } else if s1 > s2 {
                    crosspoint.ilon = lon2;
                    crosspoint.ilat = lat2;
                } else {
                    crosspoint.ilon = lon1;
                    crosspoint.ilat = lat1;
                }
            }
        }
    }

    /// One candidate way for `way_nearest`, seen from `from` to `to`.
    fn way_candidate(mwp: &MatchedWaypoint, from: Pos, to: Pos, suffix: &str) -> MatchedWaypoint {
        let angle = CheapAngleMeter::get_direction(from.ilon, from.ilat, to.ilon, to.ilat);
        let diff = CheapAngleMeter::get_difference_from_direction(mwp.direction_to_next, angle);
        let crosspoint = mwp.crosspoint.expect("updated waypoint has a crosspoint");
        let mut mw = MatchedWaypoint::new(mwp.waypoint, format!("{}{suffix}{}", mwp.name, crosspoint.hash_code()));
        mw.crosspoint = Some(crosspoint);
        mw.node1 = Some(from);
        mw.node2 = Some(to);
        mw.radius = mwp.radius;
        mw.direction_diff = diff;
        mw.direction_to_next = mwp.direction_to_next;
        mw
    }
}

/// `updateWayList`: keeps the closest ways, ties broken by the smallest direction difference.
fn update_way_list(ways: &mut Vec<MatchedWaypoint>, mw: MatchedWaypoint) {
    ways.push(mw);
    // Collections.sort is stable, as is sort_by
    ways.sort_by(|mw1, mw2| {
        jmath::double_compare(mw1.radius, mw2.radius)
            .then_with(|| jmath::double_compare(mw1.direction_diff, mw2.direction_diff))
    });
    if ways.len() > MAX_POINTS {
        ways.remove(MAX_POINTS);
    }
}

impl WaypointMatcher for WaypointMatcherImpl<'_> {
    fn start(
        &mut self,
        ilon_start: i32,
        ilat_start: i32,
        ilon_target: i32,
        ilat_target: i32,
        use_as_start_way: bool,
    ) -> bool {
        if self.island_pairs.size() > 0 {
            let n1 = Pos::new(ilon_start, ilat_start);
            let n2 = Pos::new(ilon_target, ilat_target);
            if self.island_pairs.has_pair(crate::OsmPos::id_from_pos(&n1), crate::OsmPos::id_from_pos(&n2)) {
                return false;
            }
        }
        self.lon_start = ilon_start;
        self.lon_last = ilon_start;
        self.lat_start = ilat_start;
        self.lat_last = ilat_start;
        self.lon_target = ilon_target;
        self.lat_target = ilat_target;
        self.any_update = false;
        self.use_as_start_way = use_as_start_way;
        true
    }

    fn transfer_node(&mut self, ilon: i32, ilat: i32) {
        self.check_segment(self.lon_last, self.lat_last, ilon, ilat);
        self.lon_last = ilon;
        self.lat_last = ilat;
    }

    fn end(&mut self) {
        self.check_segment(self.lon_last, self.lat_last, self.lon_target, self.lat_target);
        if !self.any_update {
            return;
        }
        let start = Pos::new(self.lon_start, self.lat_start);
        let target = Pos::new(self.lon_target, self.lat_target);
        for mwp in self.waypoints.iter_mut() {
            if !mwp.has_update {
                continue;
            }
            mwp.has_update = false;

            let forward = Self::way_candidate(mwp, start, target, "_w_");
            update_way_list(&mut mwp.way_nearest, forward);
            // revers
            let backward = Self::way_candidate(mwp, target, start, "_w2_");
            update_way_list(&mut mwp.way_nearest, backward);

            let way = &mwp.way_nearest[0];
            let (crosspoint, node1, node2, direction_diff, radius) =
                (way.crosspoint, way.node1, way.node2, way.direction_diff, way.radius);
            mwp.crosspoint = crosspoint;
            mwp.node1 = node1;
            mwp.node2 = node2;
            mwp.direction_diff = direction_diff;
            mwp.radius = radius;
        }
    }

    fn has_match(&self, lon: i32, lat: i32) -> bool {
        self.waypoints.iter().any(|mwp| {
            mwp.waypoint.ilon == lon
                && mwp.waypoint.ilat == lat
                && (mwp.radius < self.max_distance || mwp.crosspoint.is_some())
        })
    }
}

/// Port of `OsmNodePairSet`: node pairs the router found to lead into islands, collected per search
/// and frozen when the search fails. `CompactLongMap` with chained pairs becomes a map of pair lists.
#[derive(Clone)]
pub struct OsmNodePairSet {
    temp_pairs: Vec<(i64, i64)>,
    max_temp_nodes: usize,
    npairs: i32,
    freezecount: i32,
    map: CompactLongMap<Vec<i64>>,
}

impl OsmNodePairSet {
    pub fn new(max_temp_node_count: usize) -> Self {
        Self {
            temp_pairs: Vec::with_capacity(max_temp_node_count),
            max_temp_nodes: max_temp_node_count,
            npairs: 0,
            freezecount: 0,
            map: CompactLongMap::new(),
        }
    }

    pub fn add_temp_pair(&mut self, n1: i64, n2: i64) {
        if self.temp_pairs.len() < self.max_temp_nodes {
            self.temp_pairs.push((n1, n2));
        }
    }

    pub fn freeze_temp_pairs(&mut self) {
        self.freezecount += 1;
        for (n1, n2) in std::mem::take(&mut self.temp_pairs) {
            self.add_pair(n1, n2);
        }
    }

    pub fn clear_temp_pairs(&mut self) {
        self.temp_pairs.clear();
    }

    fn add_pair(&mut self, n1: i64, n2: i64) {
        self.npairs += 1;
        match self.map.get_mut(n1) {
            Some(list) => {
                if !list.contains(&n2) {
                    list.push(n2);
                }
            }
            None => self.map.fast_put(n1, vec![n2]),
        }
    }

    pub fn size(&self) -> i32 {
        self.npairs
    }

    pub fn temp_size(&self) -> usize {
        self.temp_pairs.len()
    }

    pub fn get_max_tmp_nodes(&self) -> usize {
        self.max_temp_nodes
    }

    pub fn get_freeze_count(&self) -> i32 {
        self.freezecount
    }

    pub fn has_pair(&self, n1: i64, n2: i64) -> bool {
        let has = |a: i64, b: i64| self.map.get(a).is_some_and(|list| list.contains(&b));
        has(n1, n2) || has(n2, n1)
    }
}

//! Port of `RoutingEngine` for engine modes 0 (routing) and 4 (round trip), as the planner uses it.
//!
//! Left out, because the planner's requests never reach them: alternative-route files and track output
//! (`outfileBase`, with the track message), raw reference tracks (`rawTrackPath`, so there is never a
//! nearby track and no fast partial recalculation), the search boundary, the thread watchdog
//! (`terminate()`), logging and the stack sampler. Features that would need unported code are reported
//! as errors (see `unsupported`): engine modes 2 and 3, round trips without a direction
//! (`getRandomDirectionFromData`), turn instructions (`VoiceHintProcessor`), beeline segments (which
//! also produce voice hints), kinematic models, nogos, pois, `correctMisplacedViaPoints` and
//! `continueStraight`.

use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::time::Instant;

use brouter_expressions::{ExpressionError, Profile, WayContext};
use brouter_mapaccess::{
    ElevationTypes, GeometryDecoder, MapError, MatchedWaypoint, NodeIdx, NodesCache, OsmNodePairSet, OsmPos, Pos,
    SegmentStore,
};
use brouter_util::{SortedHeap, cheap_ruler};

use crate::java::{JavaException, min_f32, parse_double};
use crate::libm;
use crate::param_collector::OsmNodeNamed;
use crate::path::{GRAVITY, OsmPath, PathEnv, PathIdx};
use crate::path_element::{ElemIdx, OsmPathElement, PathElements};
use crate::pool::Pool;
use crate::profile_cache::ProfileCache;
use crate::routing_context::RoutingContext;
use crate::track::{DetachedTrack, OsmTrack};

pub const BROUTER_ENGINEMODE_ROUTING: i32 = 0;
pub const BROUTER_ENGINEMODE_ROUNDTRIP: i32 = 4;

const MAXNODES_ISLAND_CHECK: i32 = 500;
const MAX_DYNAMIC_RANGE: f64 = 60000.0;

/// A Java exception inside `doRouting`: `RoutingIslandException` restarts the search, every other one
/// ends it with its message.
#[derive(Debug)]
enum Abort {
    Island,
    Error(String),
}

impl From<MapError> for Abort {
    fn from(e: MapError) -> Self {
        Abort::Error(e.message().to_string())
    }
}

impl From<ExpressionError> for Abort {
    fn from(e: ExpressionError) -> Self {
        Abort::Error(e.0)
    }
}

fn unsupported(feature: &str) -> Abort {
    Abort::Error(format!("not supported by this engine: {feature}"))
}

fn error(message: impl Into<String>) -> Abort {
    Abort::Error(message.into())
}

/// The message of a panic, which stands for one of Java's internal errors.
pub fn panic_message(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_else(|| "internal error".to_string())
}

/// Beyond this many paths a searcher's arenas are dropped, not kept: a thread would otherwise hold on to
/// the memory of its biggest search for good (about twice that of a long round trip).
const KEPT_PATHS: usize = (64 << 20) / std::mem::size_of::<OsmPath>();

/// Beyond this many paths a search stops with BRouter's memory error, as a search past Java's heap
/// (`-Xmx`) would end: a runaway search fails alone instead of taking the program down. Searches on the
/// planner's loops stay below half of it; the arena of a runaway one peaks at about 1.3 GB (a doubling
/// and its copy), so a few at once stay below the heap ceiling.
const MAX_SEARCH_PATHS: usize = 1 << 22;

/// The search arenas. A worker keeps them between requests: they grow to tens of megabytes, which
/// would otherwise be allocated and faulted in again for every request. The nodes cache keeps only
/// its allocations: each request opens its files again.
#[derive(Default)]
pub(crate) struct Arenas {
    paths: Vec<OsmPath>,
    elements: PathElements,
    nodes_cache: Option<NodesCache>,
    open_set: SortedHeap<PathIdx>,
}

/// What a search needs of a matched waypoint: its way section and the cross point on it.
#[derive(Clone, Copy)]
pub(crate) struct SearchEnd {
    node1: Pos,
    node2: Pos,
    crosspoint: Pos,
    waypoint: Pos,
}

impl SearchEnd {
    fn of(mwp: &MatchedWaypoint) -> Self {
        let matched = |p: Option<Pos>| p.expect("matched waypoint");
        Self {
            node1: matched(mwp.node1),
            node2: matched(mwp.node2),
            crosspoint: matched(mwp.crosspoint),
            waypoint: mwp.waypoint,
        }
    }
}

pub struct RoutingEngine {
    waypoints: Vec<OsmNodeNamed>,
    engine_mode: i32,
    matched_waypoints: Option<Vec<MatchedWaypoint>>,
    found_track: OsmTrack,
    error_message: Option<String>,
    /// The state of the searches the request runs on its own thread.
    search: Searcher,
    /// Where the request's island checks and sections run side by side, while that gives Java's
    /// results: see `parallel_allowed`.
    pool: Option<Pool>,
}

/// A search a request hands to the pool: one island check, or one section's searches.
pub(crate) struct Job {
    kind: JobKind,
    /// The request's context, with the search direction set.
    rc: RoutingContext,
    island_node_pairs: OsmNodePairSet,
    max_running_time: i64,
    /// The request's clock: Java times all searches of a request from its start.
    start_time: Instant,
}

#[derive(Clone, Copy)]
enum JobKind {
    IslandCheck { start: SearchEnd, end: SearchEnd },
    Section { start: SearchEnd, end: SearchEnd },
}

/// What a request needs of a search that ran apart from it.
pub(crate) struct JobResult {
    outcome: Result<JobOutput, Abort>,
    /// The island pairs and cost factors as the search left them, which an island restart goes on from.
    island_node_pairs: OsmNodePairSet,
    air_distance_cost_factor: f64,
    last_air_distance_cost_factor: f64,
    /// Whether a beeline path moved `OsmPath.seg`, which the following sections would have continued.
    segment_counter_moved: bool,
    /// The search's last cache, as `recalcTrack` reads it after the last section.
    elevation_types: ElevationTypes,
}

impl JobResult {
    /// A job that ended with an internal error (a panic) outside its search, which ends the request.
    pub(crate) fn panicked(panic: &(dyn Any + Send)) -> Self {
        Self {
            outcome: Err(error(panic_message(panic))),
            island_node_pairs: OsmNodePairSet::new(MAXNODES_ISLAND_CHECK as usize),
            air_distance_cost_factor: 0.0,
            last_air_distance_cost_factor: 0.0,
            segment_counter_moved: false,
            elevation_types: ElevationTypes::default(),
        }
    }
}

enum JobOutput {
    /// Whether the check found an island.
    IslandCheck(bool),
    /// A section's track, in the arena of the searcher that ran it, or detached from another thread's.
    Section(OsmTrack),
    Detached(DetachedTrack),
}

/// What the searches of a request read and change: Java's `RoutingEngine` fields below `_findTrack`.
struct Searcher {
    segments: Arc<SegmentStore>,
    rc: RoutingContext,
    profile: Profile,

    nodes_cache: Option<NodesCache>,
    geometry: GeometryDecoder,
    open_set: SortedHeap<PathIdx>,
    /// The paths of the current search; link holders refer to them by index.
    paths: Vec<OsmPath>,
    elements: PathElements,

    island_node_pairs: OsmNodePairSet,
    node_limit: i32, // used for target island search

    air_distance_cost_factor: f64,
    last_air_distance_cost_factor: f64,
    guide_track: Option<OsmTrack>,
    match_path: Option<ElemIdx>,
    start_time: Instant,
    max_running_time: i64,
    direct_segment: i32,
}

/// Runs a decoding step of the cache, failing with the profile error the decoder swallowed, if any
/// (Java's exception would have ended the decoding).
fn decoding<T>(way: &mut WayContext, step: impl FnOnce(&mut WayContext) -> Result<T, MapError>) -> Result<T, Abort> {
    let result = step(way);
    if let Some(e) = way.take_deferred_error() {
        return Err(e.into());
    }
    Ok(result?)
}

/// `NodesCache.obtainNonHollowNode`.
fn obtain(cache: &mut NodesCache, way: &mut WayContext, n: NodeIdx) -> Result<bool, Abort> {
    if !cache.nodes_map.is_hollow(n) {
        return Ok(true); // nothing to decode
    }
    decoding(way, |way| cache.obtain_non_hollow_node(n, way))
}

/// `CheapRuler.destination`, with Java's `Math.sin`/`Math.cos` (the platform's differ in the last bit).
fn destination(lon1: i32, lat1: i32, distance: f64, angle: f64) -> (i32, i32) {
    let lonlat2m = cheap_ruler::get_lon_lat_to_meter_scales(lat1);
    let angle = 90.0 - angle;
    let st = libm::sin(angle * std::f64::consts::PI / 180.0);
    let ct = libm::cos(angle * std::f64::consts::PI / 180.0);
    let lon2 = (0.5 + f64::from(lon1) + ct * distance / lonlat2m[0]) as i32;
    let lat2 = (0.5 + f64::from(lat1) + st * distance / lonlat2m[1]) as i32;
    (lon2, lat2)
}

impl RoutingEngine {
    /// Like Java's constructor, parses (or reuses) the profile named by `rc.local_function`.
    pub fn new(
        segments: &Arc<SegmentStore>,
        waypoints: Vec<OsmNodeNamed>,
        rc: RoutingContext,
        engine_mode: i32,
        profiles: &mut ProfileCache,
    ) -> Result<Self, JavaException> {
        Self::with_arenas(segments, waypoints, rc, engine_mode, profiles, Arenas::default())
    }

    pub(crate) fn with_arenas(
        segments: &Arc<SegmentStore>,
        waypoints: Vec<OsmNodeNamed>,
        mut rc: RoutingContext,
        engine_mode: i32,
        profiles: &mut ProfileCache,
        arenas: Arenas,
    ) -> Result<Self, JavaException> {
        if rc.local_function.is_none() {
            // new File(routingContext.localFunction)
            return Err(JavaException { class: "java.lang.NullPointerException", message: None });
        }
        let profile = profiles.parse_profile(&mut rc)?;
        let island_node_pairs = OsmNodePairSet::new(MAXNODES_ISLAND_CHECK as usize);
        Ok(Self {
            waypoints,
            engine_mode,
            matched_waypoints: None,
            found_track: OsmTrack::new(),
            error_message: None,
            pool: None,
            search: Searcher::new(segments, rc, profile, arenas, island_node_pairs, 0),
        })
    }

    /// `doRun`. Errors of the routing itself end up in `error_message`; the `Err` cases are the
    /// exceptions Java's `doRun` throws.
    pub fn do_run(&mut self, max_running_time: i64) -> Result<(), JavaException> {
        match self.engine_mode {
            BROUTER_ENGINEMODE_ROUTING => {
                if self.waypoints.len() < 2 {
                    return Err(JavaException::illegal_argument("we need two lat/lon points at least!"));
                }
                self.do_routing(max_running_time);
            }
            2 | 3 => {
                if self.waypoints.is_empty() {
                    return Err(JavaException::illegal_argument("we need one lat/lon point at least!"));
                }
                self.fail(unsupported("engine modes 2 and 3 (getElev, getInfo)"));
            }
            BROUTER_ENGINEMODE_ROUNDTRIP => {
                if self.waypoints.is_empty() {
                    return Err(JavaException::illegal_argument("we need one lat/lon point at least!"));
                }
                self.do_round_trip();
            }
            _ => return Err(JavaException::illegal_argument("not a valid engine mode")),
        }
        Ok(())
    }

    pub fn error_message(&self) -> Option<&str> {
        self.error_message.as_deref()
    }

    pub fn found_track(&self) -> &OsmTrack {
        &self.found_track
    }

    pub fn elements(&self) -> &PathElements {
        &self.search.elements
    }

    /// Ends the request: returns the profile to the cache (Java's `ProfileCache.releaseProfile`).
    pub fn release_profile(self, profiles: &mut ProfileCache) {
        self.finish(profiles);
    }

    /// `release_profile`, handing back the arenas for the next request.
    pub(crate) fn finish(self, profiles: &mut ProfileCache) -> Arenas {
        self.search.release(profiles)
    }

    /// Lets the request run its island checks and sections on the pool's threads.
    pub(crate) fn set_pool(&mut self, pool: Option<&Pool>) {
        self.pool = pool.cloned();
    }

    /// Whether searches may run apart from each other and from the request's thread. They give
    /// Java's results when no search depends on another: the profile's results depend on the
    /// descriptions alone (so neither the evaluation order nor the result caches matter), and the
    /// request has not restarted after an island (Java's restart goes on with the stale cost factors
    /// of the failed search).
    fn parallel_allowed(&self) -> Option<&Pool> {
        let profile = &self.search.profile;
        self.pool.as_ref().filter(|pool| {
            pool.threads() > 1
                && profile.way.depends_on_description_only()
                && profile.node.depends_on_description_only()
        })
    }

    /// A job for the pool, from the request's current state.
    fn job(&self, kind: JobKind) -> Job {
        let search = &self.search;
        let mut rc = search.rc.clone();
        if let JobKind::Section { .. } = kind {
            rc.inverse_direction = rc.inverse_routing;
        }
        Job {
            kind,
            rc,
            island_node_pairs: search.island_node_pairs.clone(),
            max_running_time: search.max_running_time,
            start_time: search.start_time,
        }
    }

    /// The outcome of a job. On failure the request goes on, as after Java's failed search, with the
    /// job's island pairs and cost factors: an island restart reads them.
    fn adopt(&mut self, result: JobResult) -> Result<JobOutput, Abort> {
        if result.outcome.is_err() {
            self.search.island_node_pairs = result.island_node_pairs;
            self.search.air_distance_cost_factor = result.air_distance_cost_factor;
            self.search.last_air_distance_cost_factor = result.last_air_distance_cost_factor;
        }
        result.outcome
    }

    /// `logException`: the message of the exception that ended the routing.
    fn fail(&mut self, abort: Abort) {
        self.error_message = Some(match abort {
            Abort::Error(message) => message,
            Abort::Island => unreachable!("islands restart in find_track_retrying"),
        });
    }

    fn do_routing(&mut self, max_running_time: i64) {
        // Java turns every exception and error into the error message, the data layer's internal
        // errors (panics here) included
        match catch_unwind(AssertUnwindSafe(|| self.try_routing(max_running_time))) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => self.fail(e),
            Err(panic) => self.error_message = Some(panic_message(&*panic)),
        }
        // finally: close the open set (the profile is released by the caller, and the cache kept for
        // its allocations only)
        self.search.open_set.clear();
        self.search.paths.clear();
    }

    fn try_routing(&mut self, max_running_time: i64) -> Result<(), Abort> {
        self.search.start_time = Instant::now();
        self.search.max_running_time = max_running_time;

        if let Some(feature) = self.search.rc.unsupported_feature() {
            return Err(unsupported(&feature));
        }

        if self.search.rc.allow_samewayback {
            let wps = &mut self.waypoints;
            if wps.len() == 2 {
                let first = &wps[0];
                wps.push(OsmNodeNamed::new(first.ilon, first.ilat, "to"));
            } else {
                let n = wps.len();
                wps[n - 1].name = format!("via{}_center", n - 1);
                let mut newpoints: Vec<OsmNodeNamed> =
                    wps[..n - 1].iter().rev().map(|wp| OsmNodeNamed::new(wp.ilon, wp.ilat, "via")).collect();
                if let Some(last) = newpoints.last_mut() {
                    last.name = "to".to_string();
                }
                wps.append(&mut newpoints);
            }
        }

        let nsections = self.waypoints.len() - 1;
        let mut ref_tracks: Vec<Option<OsmTrack>> = (0..nsections).map(|_| None).collect(); // used ways for alternatives
        let mut last_tracks: Vec<Option<OsmTrack>> = (0..nsections).map(|_| None).collect();
        let alternative = self.search.rc.get_alternative_idx(0, 3);
        for i in 0.. {
            let mut track = self.find_track_retrying(&mut ref_tracks, &mut last_tracks)?;
            track.name = format!("brouter_{}_{i}", self.search.rc.get_profile_name());
            if i == alternative {
                self.found_track = track;
                break;
            }
        }
        Ok(())
    }

    fn do_round_trip(&mut self) {
        self.search.rc.use_dynamic_distance = true;
        let search_radius = self.search.rc.round_trip_distance.map_or(1500.0, f64::from);
        let direction = self.search.rc.start_direction.map_or(-1.0, f64::from);
        if direction == -1.0 {
            self.fail(unsupported("round trips without a direction (BRouter picks a random one)"));
            return;
        }

        if self.search.rc.allow_samewayback {
            let start = &self.waypoints[0];
            let (lon, lat) = destination(start.ilon, start.ilat, search_radius, direction);
            self.waypoints.push(OsmNodeNamed::new(lon, lat, "rt1"));
        } else {
            self.build_points_from_circle(direction, search_radius, self.search.rc.round_trip_points.unwrap_or(5));
        }

        self.search.rc.waypoint_catching_range = 250.0;

        self.do_routing(0);
    }

    fn build_points_from_circle(&mut self, start_angle: f64, search_radius: f64, points: i32) {
        let (lon, lat) = (self.waypoints[0].ilon, self.waypoints[0].ilat);
        for i in 1..points {
            let an_angle = 90.0 - (180.0 * f64::from(i) / f64::from(points));
            let (lon2, lat2) = destination(lon, lat, search_radius, start_angle - an_angle);
            self.waypoints.push(OsmNodeNamed::new(lon2, lat2, format!("rt{i}")));
        }
        self.waypoints.push(OsmNodeNamed::new(lon, lat, "to_rt"));
    }

    /// `findTrack(refTracks, lastTracks)`: restarts after a target island was found.
    fn find_track_retrying(
        &mut self,
        ref_tracks: &mut [Option<OsmTrack>],
        last_tracks: &mut [Option<OsmTrack>],
    ) -> Result<OsmTrack, Abort> {
        loop {
            match self.try_find_track(ref_tracks, last_tracks) {
                Err(Abort::Island) => {
                    if self.search.rc.use_dynamic_distance {
                        for mwp in self.matched_waypoints.iter().flatten() {
                            if mwp.name.contains("_add")
                                && let (Some(n1), Some(n2)) = (mwp.node1, mwp.node2)
                            {
                                self.search.island_node_pairs.add_temp_pair(n1.id_from_pos(), n2.id_from_pos());
                            }
                        }
                    }
                    self.search.island_node_pairs.freeze_temp_pairs();
                    if let Some(cache) = &mut self.search.nodes_cache {
                        cache.clean(true);
                    }
                    self.matched_waypoints = None;
                    // Java's restart goes on with the failed search's cost factors: one search at a time
                    self.pool = None;
                }
                result => return result,
            }
        }
    }

    /// `tryFindTrack`. Without extra waypoints from a broken round (`useNodePoints` is never set) and
    /// beeline points (unsupported), the waypoints never outgrow the track arrays, which Java would
    /// otherwise reallocate together with switching to direct routing.
    fn try_find_track(
        &mut self,
        ref_tracks: &mut [Option<OsmTrack>],
        last_tracks: &mut [Option<OsmTrack>],
    ) -> Result<OsmTrack, Abort> {
        let mut totaltrack = OsmTrack::new();
        let has_direct_routing = self.waypoints.iter().any(|wp| wp.wpttype == MatchedWaypoint::WAYPOINT_TYPE_DIRECT);
        let inverse_routing = self.search.rc.inverse_routing;
        // The sections side by side, unless alternatives make them depend on earlier tracks.
        let sections_side_by_side = !has_direct_routing && last_tracks.iter().all(Option::is_none);
        let start_time = self.search.start_time;

        // without a raw track file there is never a nearby track for the target
        if self.matched_waypoints.is_none() {
            // could exist from the previous alternative level
            let mut mwps: Vec<MatchedWaypoint> = self
                .waypoints
                .iter()
                .map(|wp| {
                    let mut mwp = MatchedWaypoint::new(Pos::new(wp.ilon, wp.ilat), wp.name.clone());
                    mwp.wpttype = wp.wpttype;
                    mwp
                })
                .collect();
            let matching = self.search.match_waypoints_to_nodes(&mut mwps);
            self.matched_waypoints = Some(mwps); // the island restart reads them
            matching?;
            let sections: Vec<(SearchEnd, i8)> =
                self.matched_waypoints.iter().flatten().map(|mwp| (SearchEnd::of(mwp), mwp.wpttype)).collect();

            // detect target islands: restricted search in inverse direction
            self.search.rc.inverse_direction = !self.search.rc.inverse_routing;
            self.search.air_distance_cost_factor = 0.0;
            let checks: Vec<(usize, JobKind)> = (0..sections.len() - 1)
                .filter(|&i| sections[i].1 != MatchedWaypoint::WAYPOINT_TYPE_DIRECT)
                .map(|i| (i, JobKind::IslandCheck { start: sections[i].0, end: sections[i + 1].0 }))
                .collect();
            // The sections wait for the checks: a section into an island would search the whole map.
            let kinds: Vec<JobKind> = checks.iter().map(|&(_, kind)| kind).collect();
            let mut side_by_side = self.run_side_by_side(&kinds).map(Vec::into_iter);
            for &(i, kind) in &checks {
                let checked = match side_by_side.as_mut() {
                    Some(results) => self.adopt(results.next().expect("a result per job"))?,
                    None => self.search.run(kind)?,
                };
                let JobOutput::IslandCheck(island) = checked else { unreachable!("an island check") };
                if island {
                    let side = if self.search.rc.inverse_routing { "start" } else { "target" };
                    return Err(error(format!("{side} island detected for section {i}")));
                }
            }
            self.search.rc.inverse_direction = false;
            self.search.node_limit = 0;
        }

        if has_direct_routing {
            return Err(unsupported("beeline (direct) routing"));
        }

        let mwps = self.matched_waypoints.as_deref().expect("matched above");
        let ends: Vec<SearchEnd> = mwps.iter().map(SearchEnd::of).collect();
        // where correctMisplacedViaPoints would snap the connection at a via point (snapPathConnection)
        let snaps: Vec<bool> = (0..ends.len() - 1)
            .map(|i| {
                let start = &mwps[if self.search.rc.inverse_routing { i + 1 } else { i }];
                self.search.rc.correct_misplaced_via_points
                    && mwps[i].wpttype != MatchedWaypoint::WAYPOINT_TYPE_DIRECT
                    && mwps[i].wpttype != MatchedWaypoint::WAYPOINT_TYPE_MEETING
                    && !self.search.rc.allow_samewayback
                    && (start.name.starts_with("via") || start.name.starts_with("rt"))
            })
            .collect();

        let mut section_results = None;
        if sections_side_by_side {
            let kinds: Vec<JobKind> = (0..ends.len() - 1)
                .map(|i| {
                    let (start, end) = if inverse_routing { (ends[i + 1], ends[i]) } else { (ends[i], ends[i + 1]) };
                    JobKind::Section { start, end }
                })
                .collect();
            section_results = self.run_side_by_side(&kinds);
        }
        // A moved segment counter would have carried over into the following sections: one at a time
        // then, from the state of a first attempt's sections (side by side only runs in one).
        if section_results.as_ref().is_some_and(|results| results.iter().any(|r| r.segment_counter_moved)) {
            section_results = None;
            let search = &mut self.search;
            (search.air_distance_cost_factor, search.last_air_distance_cost_factor) = (0.0, 0.0);
            search.start_time = start_time;
        }
        let mut side_by_side = section_results.map(Vec::into_iter);
        let mut last_cache = None; // the elevation types of the last section's last search

        self.search.direct_segment = 1; // OsmPath.seg = 1
        for i in 0..ends.len() - 1 {
            if let Some(last) = &last_tracks[i] {
                ref_tracks[i].get_or_insert_with(OsmTrack::new).add_nodes(last, &self.search.elements);
            }

            let seg = match side_by_side.as_mut() {
                Some(results) => {
                    let result = results.next().expect("a result per section");
                    last_cache = Some(result.elevation_types.clone());
                    match self.adopt(result)? {
                        JobOutput::Section(track) => track,
                        JobOutput::Detached(track) => OsmTrack::attach(track, &mut self.search.elements),
                        JobOutput::IslandCheck(_) => unreachable!("a section"),
                    }
                }
                None if inverse_routing => {
                    self.search.rc.inverse_direction = true;
                    let seg = self.search.search_track(ends[i + 1], ends[i], ref_tracks[i].as_ref());
                    self.search.rc.inverse_direction = false;
                    seg?
                }
                None => self.search.search_track(ends[i], ends[i + 1], ref_tracks[i].as_ref())?,
            };
            if !inverse_routing && self.search.rc.continue_straight && i < ends.len() - 2 {
                return Err(unsupported("continueStraight"));
            }

            if snaps[i] && !totaltrack.nodes.is_empty() {
                return Err(unsupported("correctMisplacedViaPoints"));
            }

            totaltrack.append_track(&seg, &mut self.search.elements);
            last_tracks[i] = Some(seg);
        }

        self.search.post_elevation_check(&totaltrack)?;
        let last_cache = last_cache
            .unwrap_or_else(|| self.search.nodes_cache.as_ref().map(NodesCache::elevation_types).unwrap_or_default());
        self.search.recalc_track(&mut totaltrack, &last_cache);
        // processVoiceHints: without a detour map and direct routing it returns an empty list
        Ok(totaltrack)
    }

    /// Runs the jobs side by side on the pool (and this thread), if that gives Java's results; their
    /// results in order, else `None` to run them one by one.
    fn run_side_by_side(&mut self, kinds: &[JobKind]) -> Option<Vec<JobResult>> {
        let pool = self.parallel_allowed()?.clone();
        if kinds.len() < 2 {
            return None;
        }
        let jobs = kinds.iter().map(|&kind| self.job(kind)).collect();
        let search = &mut self.search;
        Some(pool.run(jobs, |job| search.run_local(job)))
    }
}

impl Searcher {
    /// A searcher in the arenas of earlier searches.
    fn new(
        segments: &Arc<SegmentStore>,
        rc: RoutingContext,
        profile: Profile,
        mut arenas: Arenas,
        island_node_pairs: OsmNodePairSet,
        max_running_time: i64,
    ) -> Self {
        arenas.paths.clear();
        arenas.elements.clear();
        arenas.open_set.clear();
        Self {
            segments: segments.clone(),
            rc,
            profile,
            nodes_cache: arenas.nodes_cache,
            geometry: GeometryDecoder::new(),
            open_set: arenas.open_set,
            paths: arenas.paths,
            elements: arenas.elements,
            island_node_pairs,
            node_limit: 0,
            air_distance_cost_factor: 0.0,
            last_air_distance_cost_factor: 0.0,
            guide_track: None,
            match_path: None,
            start_time: Instant::now(),
            max_running_time,
            direct_segment: 1,
        }
    }

    /// Returns the profile to the cache (Java's `ProfileCache.releaseProfile`) and the arenas for the
    /// next searcher, with the nodes cache's files and cells dropped.
    fn release(self, profiles: &mut ProfileCache) -> Arenas {
        profiles.release_profile(self.profile, &self.rc);
        if self.paths.capacity() > KEPT_PATHS {
            return Arenas::default();
        }
        let mut nodes_cache = self.nodes_cache;
        if let Some(cache) = &mut nodes_cache {
            cache.forget_files();
        }
        Arenas { paths: self.paths, elements: self.elements, nodes_cache, open_set: self.open_set }
    }

    /// The searches of a job, run in turn by the request or apart as a job.
    fn run(&mut self, kind: JobKind) -> Result<JobOutput, Abort> {
        match kind {
            JobKind::IslandCheck { start, end } => {
                self.node_limit = MAXNODES_ISLAND_CHECK;
                let seg = if self.rc.inverse_routing {
                    self.find_track("start-island-check", start, end, None, None)?
                } else {
                    self.find_track("target-island-check", end, start, None, None)?
                };
                Ok(JobOutput::IslandCheck(seg.is_none() && self.node_limit > 0))
            }
            JobKind::Section { start, end } => self.search_track(start, end, None).map(JobOutput::Section),
        }
    }

    /// Runs a job as the request runs that step in a first attempt: with the cost factors at 0 (as
    /// the island checks and every section start) and the segment counter at 1 (as the first section
    /// starts; whether it moved is reported), on the request's clock. Java's internal errors (panics)
    /// end the job with their message, as they would end the request.
    fn run_job(&mut self, kind: JobKind, start_time: Instant) -> JobResult {
        self.air_distance_cost_factor = 0.0;
        self.last_air_distance_cost_factor = 0.0;
        self.direct_segment = 1;
        self.start_time = start_time;
        let outcome = catch_unwind(AssertUnwindSafe(|| self.run(kind)))
            .unwrap_or_else(|panic| Err(error(panic_message(&*panic))));
        JobResult {
            outcome,
            island_node_pairs: self.island_node_pairs.clone(),
            air_distance_cost_factor: self.air_distance_cost_factor,
            last_air_distance_cost_factor: self.last_air_distance_cost_factor,
            segment_counter_moved: self.direct_segment != 1,
            elevation_types: self.nodes_cache.as_ref().map(NodesCache::elevation_types).unwrap_or_default(),
        }
    }

    /// Runs one of the request's jobs on its own searcher.
    fn run_local(&mut self, job: Job) -> JobResult {
        let inverse_direction = std::mem::replace(&mut self.rc.inverse_direction, job.rc.inverse_direction);
        let result = self.run_job(job.kind, job.start_time);
        self.rc.inverse_direction = inverse_direction;
        result
    }

    /// `searchTrack` with `searchRoutedTrack` (beeline segments are excluded above).
    fn search_track(
        &mut self,
        start: SearchEnd,
        end: SearchEnd,
        ref_track: Option<&OsmTrack>,
    ) -> Result<OsmTrack, Abort> {
        let mut track: Option<OsmTrack> = None;
        let air_distance_cost_factors = [self.rc.pass1coefficient, self.rc.pass2coefficient];

        for cfi in 0..air_distance_cost_factors.len() {
            if cfi > 0 {
                self.last_air_distance_cost_factor = air_distance_cost_factors[cfi - 1];
            }
            self.air_distance_cost_factor = air_distance_cost_factors[cfi];

            if self.air_distance_cost_factor < 0.0 {
                continue;
            }

            // Java prepares a dirty reference track before passing on a timeout; nothing reads it here
            let operation = if cfi == 0 { "pass0" } else { "pass1" };
            let mut t = self.find_track(operation, start, end, track.as_ref(), ref_track)?;

            if t.is_none()
                && let (Some(old), Some(match_path)) = (&track, self.match_path)
            {
                // ups, didn't find it, use a merge
                t = Some(self.merge_track(match_path, old));
            }
            match t {
                Some(t) => track = Some(t),
                None => return Err(error(format!("no track found at pass={cfi}"))),
            }
        }
        let track = track.ok_or_else(|| error("no track found"))?;

        // final run for verbose log info and detail nodes
        self.air_distance_cost_factor = 0.0;
        self.last_air_distance_cost_factor = 0.0;
        self.guide_track = Some(track);
        self.start_time = Instant::now(); // reset timeout...
        let tt = self.find_track("re-tracking", start, end, None, ref_track);
        self.guide_track = None;
        tt?.ok_or_else(|| error("error re-tracking track"))
    }

    fn reset_cache(&mut self, detailed: bool) -> Result<(), Abort> {
        let maxmem = i64::from(self.rc.memoryclass) * 1024 * 1024; // in MB
        let cache = NodesCache::new(&self.segments, &mut self.profile.way, maxmem, &mut self.nodes_cache, detailed)?;
        self.nodes_cache = Some(cache);
        self.island_node_pairs.clear_temp_pairs();
        Ok(())
    }

    /// Geometric position matching, finding the nearest routable way section.
    fn match_waypoints_to_nodes(&mut self, unmatched_waypoints: &mut Vec<MatchedWaypoint>) -> Result<(), Abort> {
        self.reset_cache(false)?;
        let use_dynamic_distance = self.rc.use_dynamic_distance;
        let range = self.rc.waypoint_catching_range;
        let mut ok = self.match_with_cache(unmatched_waypoints, range)?;
        if !ok && use_dynamic_distance {
            // second check for way points
            self.reset_cache(false)?;
            // Java matches a list sharing the waypoint objects; match copies and write them back
            let picked: Vec<usize> = (0..unmatched_waypoints.len())
                .filter(|&i| {
                    let mwp = &unmatched_waypoints[i];
                    mwp.crosspoint.is_none() || mwp.radius >= self.rc.waypoint_catching_range
                })
                .collect();
            let mut tmp: Vec<MatchedWaypoint> = picked.iter().map(|&i| unmatched_waypoints[i].clone()).collect();
            let result = self.match_with_cache(&mut tmp, -MAX_DYNAMIC_RANGE);
            for (mwp, &i) in tmp.into_iter().zip(&picked) {
                unmatched_waypoints[i] = mwp;
            }
            ok = result?;
        }
        if !ok && let Some(mwp) = unmatched_waypoints.iter().find(|mwp| mwp.crosspoint.is_none()) {
            return Err(error(format!("{}-position not mapped in existing datafile", mwp.name)));
        }
        // beeline points for waypoints far from any way (useNodePoints is never set)
        if use_dynamic_distance
            && self.rc.build_beeline_on_range
            && unmatched_waypoints.iter().any(|wp| {
                wp.crosspoint
                    .is_some_and(|cp| f64::from(wp.waypoint.calc_distance(&cp)) > self.rc.waypoint_catching_range)
            })
        {
            return Err(unsupported("beeline (direct) routing"));
        }
        Ok(())
    }

    fn match_with_cache(&mut self, waypoints: &mut Vec<MatchedWaypoint>, range: f64) -> Result<bool, Abort> {
        let cache = self.nodes_cache.as_mut().expect("cache was reset");
        let pairs = &self.island_node_pairs;
        decoding(&mut self.profile.way, |way| cache.match_waypoints_to_nodes(waypoints, range, pairs, way))
    }

    /// `getStartPath(n1, n2, mwp, endPos, sameSegmentSearch)`.
    fn get_start_path(
        &mut self,
        n1: NodeIdx,
        n2: NodeIdx,
        crosspoint: Pos,
        end_pos: Pos,
        same_segment_search: bool,
    ) -> Result<Option<PathIdx>, Abort> {
        self.rc.nogos.set_waypoint(crosspoint, same_segment_search.then_some(end_pos), false);
        let result = self.start_path_on_link(n1, n2, end_pos);
        let end_matched = same_segment_search && self.rc.nogos.endpoint_radius() < 1.5;
        self.rc.nogos.unset_waypoint();
        let p = result?;

        // special case: start+end on same segment
        if let Some(p) = p
            && self.paths[p as usize].cost >= 0
            && end_matched
        {
            self.paths[p as usize].treedepth = 0; // hack: mark for the final-check
        }
        Ok(p)
    }

    /// `getStartPath(n1, n2, wp, endPos, sameSegmentSearch)`, with the waypoint set in the nogo list.
    fn start_path_on_link(&mut self, n1: NodeIdx, n2: NodeIdx, end_pos: Pos) -> Result<Option<PathIdx>, Abort> {
        let cache = self.nodes_cache.as_mut().expect("cache was reset");
        let start_link = cache.nodes_map.create_link(None, Some(n1));
        let start_path = self.paths.len() as PathIdx;
        self.paths.push(OsmPath::start(start_link, &cache.nodes_map));
        // Java adds the start path as the start link's holder; the start link is in no node's chain,
        // so nothing ever reads it.
        let map = &cache.nodes_map;
        let mut best: Option<(OsmPath, brouter_mapaccess::LinkIdx)> = None;
        let mut minradius = 1e10;
        let mut l = map.node(n1).firstlink;
        while let Some(link) = l {
            let next_node = map.target(link, n1);
            // skip border nodes, dead ends, self links and every other link than the one to n2
            if !map.is_hollow(next_node)
                && map.node(next_node).firstlink.is_some()
                && next_node != n1
                && next_node == n2
            {
                self.rc.nogos.rearm_waypoint();
                let mut env = PathEnv {
                    rc: &mut self.rc,
                    profile: &mut self.profile,
                    geometry: &mut self.geometry,
                    map,
                    elements: &mut self.elements,
                    direct_segment: &mut self.direct_segment,
                };
                let mut test_path =
                    OsmPath::create(&mut self.paths, start_path, link, None, self.guide_track.is_some(), &mut env)?;
                test_path.airdistance = map.node(next_node).calc_distance(&end_pos);
                if self.rc.nogos.waypoint_radius() < minradius {
                    minradius = self.rc.nogos.waypoint_radius();
                    best = Some((test_path, link));
                }
            }
            l = map.next_link(link, n1);
        }
        let Some((mut best_path, best_link)) = best else { return Ok(None) };
        best_path.treedepth = 1;
        let idx = self.paths.len() as PathIdx;
        self.paths.push(best_path);
        if let Some(previous) = cache.nodes_map.link_mut(best_link).add_link_holder(idx, n1) {
            self.paths[idx as usize].set_next_for_link(previous);
        }
        Ok(Some(idx))
    }

    /// `findTrack(operationName, startWp, endWp, costCuttingTrack, refTrack, fastPartialRecalc)`.
    /// Without a nearby track `fastPartialRecalc` is always false, so it is left out here and below.
    fn find_track(
        &mut self,
        operation_name: &str,
        start: SearchEnd,
        end: SearchEnd,
        cost_cutting_track: Option<&OsmTrack>,
        ref_track: Option<&OsmTrack>,
    ) -> Result<Option<OsmTrack>, Abort> {
        if let Some(areas) = &mut self.rc.nogos.local_areas {
            areas.clean(&[start.waypoint, end.waypoint]);
        }
        let detailed = self.guide_track.is_some();
        let result = self.reset_cache(detailed).and_then(|()| {
            let cleanup_mode = if detailed {
                0
            } else if self.rc.consider_turn_restrictions {
                2
            } else {
                1
            };
            self.nodes_cache.as_mut().expect("cache was reset").nodes_map.cleanup_mode = cleanup_mode;
            self.search(operation_name, start, end, cost_cutting_track, ref_track)
        });
        if let Some(cache) = &mut self.nodes_cache {
            cache.clean(false); // clean only non-virgin caches
        }
        result
    }

    /// `_findTrack`: the A* search over the graph the cache loads on demand.
    fn search(
        &mut self,
        operation_name: &str,
        start: SearchEnd,
        end: SearchEnd,
        cost_cutting_track: Option<&OsmTrack>,
        ref_track: Option<&OsmTrack>,
    ) -> Result<Option<OsmTrack>, Abort> {
        let mut max_total_cost = self.guide_track.as_ref().map_or(1_000_000_000, |g| g.cost.wrapping_add(5000));

        self.match_path = None;
        let mut nodes_visited = 0;

        let (end_node_id1, end_node_id2) = (end.node1.id_from_pos(), end.node2.id_from_pos());
        let end_pos = end.crosspoint;

        let cache = self.nodes_cache.as_mut().expect("cache was reset");
        let start1 = cache.get_graph_node(&start.node1);
        let start2 = cache.get_graph_node(&start.node2);
        let end1 = cache.get_graph_node(&end.node1);
        let end2 = cache.get_graph_node(&end.node2);
        cache.nodes_map.end_node1 = Some(end1);
        cache.nodes_map.end_node2 = Some(end2);
        let same_segment_search = (start1 == end1 && start2 == end2) || (start1 == end2 && start2 == end1);
        let way = &mut self.profile.way;
        for n in [start1, start2] {
            if !obtain(cache, way, n)? {
                return Ok(None);
            }
            decoding(way, |way| cache.expand_hollow_link_targets(n, way))?;
        }

        let rc = &mut self.rc;
        rc.start_direction_valid =
            rc.force_use_start_direction && rc.start_direction.is_some() && !rc.inverse_direction;

        self.paths.clear();
        let start_path1 = self.get_start_path(start1, start2, start.crosspoint, end_pos, same_segment_search)?;
        let start_path2 = self.get_start_path(start2, start1, start.crosspoint, end_pos, same_segment_search)?;

        // the initial match with the cost-cutting track only matters for fast partial recalcs
        let (Some(start_path1), Some(start_path2)) = (start_path1, start_path2) else { return Ok(None) };

        let Self {
            rc,
            profile,
            nodes_cache,
            geometry,
            open_set,
            paths,
            elements,
            island_node_pairs,
            node_limit,
            air_distance_cost_factor,
            last_air_distance_cost_factor,
            guide_track,
            match_path,
            start_time,
            max_running_time,
            direct_segment,
            ..
        } = self;
        let cache = nodes_cache.as_mut().expect("cache was reset");
        let (air_distance_cost_factor, last_air_distance_cost_factor) =
            (*air_distance_cost_factor, *last_air_distance_cost_factor);
        let open_key = |p: &OsmPath| p.cost.wrapping_add((f64::from(p.airdistance) * air_distance_cost_factor) as i32);
        let detail_mode = guide_track.is_some();

        open_set.clear();
        for p in [start_path1, start_path2] {
            // addToOpenset
            if paths[p as usize].cost >= 0 {
                open_set.add(open_key(&paths[p as usize]), p);
            }
        }
        let mut open_border_list: Vec<PathIdx> = Vec::with_capacity(4096);
        let mut memory_panic_mode = false;
        let mut need_non_panic_processing = false;

        let mut iterations = 0u32;
        loop {
            // the watchdog never terminates this engine; the clock is read every 256 steps (Java: every
            // step), which delays a timeout by well under a millisecond
            iterations = iterations.wrapping_add(1);
            if iterations.is_multiple_of(256) {
                if paths.len() > MAX_SEARCH_PATHS {
                    return Err(error("memory limit reached"));
                }
                let timeout = *max_running_time;
                if timeout > 0 && start_time.elapsed().as_millis() as i64 > timeout {
                    return Err(error(format!("{operation_name} timeout after {} seconds", timeout / 1000)));
                }
            }

            let Some(path) = open_set.pop_lowest_key_value() else {
                if open_border_list.is_empty() {
                    break;
                }
                for p in open_border_list.drain(..) {
                    open_set.add(open_key(&paths[p as usize]), p);
                }
                memory_panic_mode = false;
                need_non_panic_processing = true;
                continue;
            };
            let pi = path as usize;

            if paths[pi].airdistance == -1 {
                continue;
            }

            // Direct weaving is always on. Java looks for hollow link targets first; the answer only
            // matters when the memory check runs, otherwise the pre-pass below finds them itself.
            let memory_check = memory_panic_mode || !cache.nodes_map.is_in_memory_bounds(open_set.get_size(), false);
            let hollow_link_targets = memory_check && cache.has_hollow_link_targets(paths[pi].target_node);
            if hollow_link_targets {
                if !memory_panic_mode {
                    // not in memory bounds
                    cache.nodes_map.collect_outreachers()?;
                    while let Some(p3) = open_set.pop_lowest_key_value() {
                        let p3_path = &paths[p3 as usize];
                        if p3_path.airdistance != -1 && cache.nodes_map.can_escape(p3_path.target_node) {
                            open_border_list.push(p3);
                        }
                    }
                    cache.nodes_map.clear_temp();
                    for p in open_border_list.drain(..) {
                        open_set.add(open_key(&paths[p as usize]), p);
                    }
                    if !cache.nodes_map.is_in_memory_bounds(open_set.get_size(), true) {
                        if max_total_cost < 1_000_000_000 || need_non_panic_processing {
                            return Err(error("memory limit reached"));
                        }
                        memory_panic_mode = true;
                    }
                }
                if memory_panic_mode {
                    open_border_list.push(path);
                    continue;
                }
            }
            need_non_panic_processing = false;

            if *node_limit > 0 {
                // check node-limit for target island search
                *node_limit -= 1;
                if *node_limit == 0 {
                    return Ok(None);
                }
            }

            nodes_visited += 1;

            let current_link = paths[pi].link;
            let source_node = paths[pi].source_node.expect("searched paths have a source");
            let current_node = paths[pi].target_node;

            if cache.nodes_map.link(current_link).is_link_unused() {
                continue;
            }

            let current_node_id = cache.nodes_map.id_from_pos(current_node);
            let source_node_id = cache.nodes_map.id_from_pos(source_node);

            if !paths[pi].did_enter_destination_area() {
                island_node_pairs.add_temp_pair(source_node_id, current_node_id);
            }

            if paths[pi].treedepth != 1 {
                if paths[pi].treedepth == 0 {
                    // hack: sameSegment Paths marked treedepth=0 to pass above check
                    paths[pi].treedepth = 1;
                }

                if (source_node_id == end_node_id1 && current_node_id == end_node_id2)
                    || (source_node_id == end_node_id2 && current_node_id == end_node_id1)
                {
                    // track found, compile
                    let mut t = compile_track(paths, path, &cache.nodes_map, elements, detail_mode, rc.inverse_routing);
                    t.showspeed = rc.showspeed;
                    return Ok(Some(t));
                }

                // check for a match with the cost-cutting-track
                if let Some(cct) = cost_cutting_track
                    && let Some(pe) = cct.get_link(source_node_id, current_node_id, elements)
                {
                    // (the first match cost only matters for fast partial recalcs)
                    let p = &paths[pi];
                    let cost_estimate = p
                        .cost
                        .wrapping_add(p.elevation_correction())
                        .wrapping_add(cct.cost.wrapping_sub(elements[pe].cost));
                    if cost_estimate <= max_total_cost {
                        let message = p.message.clone();
                        *match_path = Some(OsmPath::new_element(paths, path, message, &cache.nodes_map, elements));
                    }
                    if cost_estimate < max_total_cost {
                        max_total_cost = cost_estimate;
                    }
                }
            }

            let first_link_holder = cache.nodes_map.link(current_link).first_link_holder(source_node);
            let mut holder = first_link_holder;
            while let Some(h) = holder {
                paths[h as usize].airdistance = -1; // invalidate the entry in the open set
                holder = paths[h as usize].next_for_link();
            }

            if paths[pi].treedepth > 1 {
                let is_bidir = cache.nodes_map.link(current_link).is_bidirectional();
                cache.nodes_map.unlink_link(source_node, current_link);

                // if the counterlink is alive and does not yet have a path, remove it
                if is_bidir
                    && cache.nodes_map.link(current_link).first_link_holder(current_node).is_none()
                    && !rc.consider_turn_restrictions
                {
                    cache.nodes_map.unlink_link(current_node, current_link);
                }
            }

            // recheck cutoff before doing expensive stuff
            let add_diff = 100;
            if paths[pi].cost.wrapping_add(paths[pi].airdistance) > max_total_cost.wrapping_add(add_diff) {
                continue;
            }

            cache.nodes_map.current_max_cost = max_total_cost;
            cache.nodes_map.current_path_cost = paths[pi].cost;
            cache.nodes_map.destination = Some(end_pos);

            // StdModel creates no pre-paths, so this first pass over the links only loads the neighbours.
            // It has nothing to load if the check above found none hollow: nothing since makes a node hollow.
            if hollow_link_targets || !memory_check {
                let mut l = cache.nodes_map.node(current_node).firstlink;
                while let Some(link) = l {
                    let next_node = cache.nodes_map.target(link, current_node);
                    obtain(cache, &mut profile.way, next_node)?;
                    l = cache.nodes_map.next_link(link, current_node);
                }
            }

            let mut l = cache.nodes_map.node(current_node).firstlink;
            while let Some(link) = l {
                'link: {
                    let next_node = cache.nodes_map.target(link, current_node);

                    if !obtain(cache, &mut profile.way, next_node)? {
                        break 'link; // border node?
                    }
                    if cache.nodes_map.node(next_node).firstlink.is_none() {
                        break 'link; // don't care about dead ends
                    }
                    if next_node == source_node {
                        break 'link; // border node?
                    }

                    let next_id = cache.nodes_map.id_from_pos(next_node);
                    if let Some(guide) = guide_track.as_ref() {
                        let gidx = (paths[pi].treedepth + 1) as usize;
                        if gidx >= guide.nodes.len() {
                            break 'link;
                        }
                        let guide_node =
                            guide.nodes[if rc.inverse_routing { guide.nodes.len() - 1 - gidx } else { gidx }];
                        if next_id != elements[guide_node].id_from_pos() {
                            // not along the guide-track: discard (with turn instructions, Java would
                            // register a detour here)
                            break 'link;
                        }
                    }

                    let mut best_path: Option<OsmPath> = None;

                    let is_final_link = (current_node_id == end_node_id1 || current_node_id == end_node_id2)
                        && (next_id == end_node_id1 || next_id == end_node_id2);

                    let mut holder = first_link_holder;
                    while let Some(other_path) = holder {
                        if is_final_link {
                            rc.nogos.set_waypoint(end_pos, None, true);
                        }
                        let mut env = PathEnv {
                            rc: &mut *rc,
                            profile: &mut *profile,
                            geometry: &mut *geometry,
                            map: &cache.nodes_map,
                            elements: &mut *elements,
                            direct_segment: &mut *direct_segment,
                        };
                        let test_path = OsmPath::create(paths, other_path, link, ref_track, detail_mode, &mut env);
                        if is_final_link {
                            rc.nogos.unset_waypoint();
                        }
                        let test_path = test_path?;
                        let map = &cache.nodes_map;
                        if test_path.cost >= 0
                            && best_path.as_ref().is_none_or(|b| test_path.cost < b.cost)
                            && map.id_from_pos(test_path.source_node.expect("created"))
                                != map.id_from_pos(test_path.target_node)
                        {
                            best_path = Some(test_path);
                        }
                        holder = paths[other_path as usize].next_for_link();
                    }
                    let Some(mut best_path) = best_path else { break 'link };

                    best_path.airdistance =
                        if is_final_link { 0 } else { cache.nodes_map.node(next_node).calc_distance(&end_pos) };

                    // (no search boundary)
                    let limit = if last_air_distance_cost_factor != 0.0 {
                        f64::from(max_total_cost) * last_air_distance_cost_factor
                    } else {
                        f64::from(max_total_cost)
                    } + f64::from(add_diff);
                    if is_final_link || f64::from(best_path.cost.wrapping_add(best_path.airdistance)) <= limit {
                        // add only if this may beat an existing path for that link
                        let mut dominator = cache.nodes_map.link(link).first_link_holder(current_node);
                        while let Some(dp) = dominator {
                            let dp = &paths[dp as usize];
                            if dp.airdistance != -1 && best_path.definitly_worse_than(dp) {
                                break;
                            }
                            dominator = dp.next_for_link();
                        }

                        if dominator.is_none() {
                            best_path.treedepth = paths[pi].treedepth + 1;
                            let idx = PathIdx::try_from(paths.len()).expect("path arena overflow");
                            paths.push(best_path);
                            if let Some(previous) = cache.nodes_map.link_mut(link).add_link_holder(idx, current_node) {
                                paths[idx as usize].set_next_for_link(previous);
                            }
                            // addToOpenset
                            if paths[idx as usize].cost >= 0 {
                                open_set.add(open_key(&paths[idx as usize]), idx);
                            }
                        }
                    }
                }
                l = cache.nodes_map.next_link(link, current_node);
            }
        }

        if nodes_visited < MAXNODES_ISLAND_CHECK && island_node_pairs.get_freeze_count() < 5 {
            return Err(Abort::Island);
        }
        Ok(None)
    }

    fn merge_track(&self, m: ElemIdx, old_track: &OsmTrack) -> OsmTrack {
        let el = &self.elements;
        let mut track = OsmTrack::new();
        track.cost = old_track.cost;

        let mut element = Some(m);
        while let Some(e) = element {
            track.nodes.push(e);
            element = el[e].origin;
        }
        track.nodes.reverse(); // addNode inserts at the front

        let id1 = el[m].id_from_pos();
        let id0 = el[m].origin.map_or(0, |o| el[o].id_from_pos());
        let mut last_id = 0;
        let mut appending = false;
        for &n in &old_track.nodes {
            if appending {
                track.nodes.push(n);
            }
            let id = el[n].id_from_pos();
            if id == id1 && last_id == id0 {
                appending = true;
            }
            last_id = id;
        }
        track.build_map(el);
        track
    }

    /// Fills elevation gaps by interpolation (or `incline` tags) between the known elevations around them.
    fn post_elevation_check(&mut self, track: &OsmTrack) -> Result<(), Abort> {
        let el = &mut self.elements;
        let nodes = &track.nodes;
        let mut last_pt: Option<ElemIdx> = None;
        let mut start_pt: Option<ElemIdx> = None;
        let mut last_elev = i16::MIN;
        let mut start_elev = i16::MIN;
        let mut end_elev = i16::MIN;
        let mut start_idx = 0usize;
        let mut dist = 0i32;
        let our_size = nodes.len();
        // the previous point exists wherever Java measures from it
        let distance =
            |el: &PathElements, a: ElemIdx, b: Option<ElemIdx>| el[a].calc_distance(&el[b.expect("a previous point")]);
        for idx in 0..our_size {
            let n = nodes[idx];
            let n_selev = el[n].selev;
            if n_selev == i16::MIN && last_elev != i16::MIN && idx < our_size - 1 {
                // start one point before entry point to get better elevation results
                if idx > 1 {
                    start_elev = el[nodes[idx - 2]].selev;
                }
                if start_elev == i16::MIN {
                    start_elev = last_elev;
                }
                start_idx = idx;
                start_pt = last_pt;
                dist = 0;
                if last_pt.is_some() {
                    dist = dist.wrapping_add(distance(el, n, last_pt));
                }
            } else if n_selev != i16::MIN && last_elev == i16::MIN && start_elev != i16::MIN {
                // end one point behind exit point to get better elevation results
                if idx + 1 < our_size {
                    end_elev = el[nodes[idx + 1]].selev;
                }
                if end_elev == i16::MIN {
                    end_elev = n_selev;
                }
                let end_idx = idx;
                let before_start = nodes[if start_idx > 1 { start_idx - 2 } else { start_idx - 1 }];
                let mut tmp_pt = before_start;
                let diff_elev = i32::from(end_elev) - i32::from(start_elev);
                dist = dist.wrapping_add(distance(el, tmp_pt, start_pt));
                dist = dist.wrapping_add(distance(el, n, last_pt));
                let mut dist_rest = dist;
                let mut incline = f64::from(diff_elev) / (f64::from(dist) / 100.0);
                let mut last_msg = String::new();
                let mut tmpincline = 0.0;
                let mut startincline = 0.0;
                let mut selev = f64::from(el[before_start].selev);
                let mut has_incline_tags = false;
                for &tmp in &nodes[start_idx - 1..end_idx + 1] {
                    if let Some(message) = &el[tmp].message {
                        let msg = message
                            .way_key_values
                            .clone()
                            .ok_or_else(|| error("Cannot invoke \"String.equals(Object)\" because \"msg\" is null"))?;
                        if msg != last_msg {
                            let revers = msg.contains("reversedirection=yes");
                            if let Some(pos) = msg.find("incline=") {
                                has_incline_tags = true;
                                let mut s = &msg[pos + 8..];
                                if let Some(p) = s.find(' ') {
                                    s = &s[..p];
                                }
                                if !s.is_empty() {
                                    if let Some(ind) = s.find('%') {
                                        s = &s[..ind];
                                    }
                                    if let Some(ind) = s.find('\u{b0}') {
                                        s = &s[..ind];
                                    }
                                    // parseDouble trims like Java's s.trim()
                                    tmpincline = match parse_double(s) {
                                        Ok(v) if revers => -v,
                                        Ok(v) => v,
                                        Err(_) => 0.0,
                                    };
                                }
                            } else {
                                tmpincline = 0.0;
                            }
                            if startincline == 0.0 {
                                startincline = tmpincline;
                            } else if startincline < 0.0 && tmpincline > 0.0 {
                                // for the way up find the exit point
                                let diff = f64::from(end_elev) - selev;
                                tmpincline = diff / (f64::from(dist_rest) / 100.0);
                            }
                        }
                        last_msg = msg;
                    }
                    let tmpdist = el[tmp].calc_distance(&el[tmp_pt]);
                    dist_rest = dist_rest.wrapping_sub(tmpdist);
                    if has_incline_tags {
                        incline = tmpincline;
                    }
                    selev += f64::from(tmpdist) / 100.0 * incline;
                    let e = &mut el[tmp];
                    e.selev = selev as i32 as i16;
                    e.message.as_mut().expect("compiled track points carry messages").ele = selev as i32 as i16;
                    tmp_pt = tmp;
                }
                dist = 0;
            } else if n_selev != i16::MIN && last_elev == i16::MIN && start_idx == 0 {
                // fill at start
                for &i in &nodes[..idx] {
                    el[i].selev = n_selev;
                }
            } else if n_selev == i16::MIN && idx == our_size - 1 {
                el[n].selev = last_elev; // fill at end (the last point)
            } else if n_selev == i16::MIN && last_pt.is_some() {
                dist = dist.wrapping_add(distance(el, n, last_pt));
            }
            last_elev = el[n].selev;
            last_pt = Some(n);
        }
        Ok(())
    }

    /// Recomputes distances, ascend and the time of time-less (beeline) sections.
    fn recalc_track(&mut self, t: &mut OsmTrack, last_cache: &ElevationTypes) {
        let mut totaldist = 0i32;
        let mut lasttime = 0.0f32;
        let mut speed_min = 9999.0f32;
        let mut direct_map: Vec<(usize, i32)> = Vec::new(); // ascending, as Java sorts its keys

        let mut ascend = 0.0f64;
        let mut ehb = 0.0f64;

        let mut ele_start = i16::MIN;
        let mut ele_end = i16::MIN;
        let ele_factor = if self.rc.inverse_routing { 0.25 } else { -0.25 };

        for i in 0..t.nodes.len() {
            let n = t.nodes[i];
            let el = &mut self.elements;
            // (the turn angle, which only voice hints read, is left out)
            let (dist, n_last) = if i == 0 {
                (0, None)
            } else {
                let p = t.nodes[i - 1];
                (el[p].calc_distance(&el[n]), Some(p))
            };
            el[n].message.get_or_insert_with(Box::default).linkdist = dist;
            totaldist = totaldist.wrapping_add(dist);
            let time = el[n].time();
            let tmptime = time - lasttime;
            if dist > 0 {
                let speed = dist as f32 / tmptime * 3.6;
                speed_min = min_f32(speed_min, speed);
            }
            if tmptime == 1.0 {
                // no time used here
                direct_map.push((i, dist));
            }
            lasttime = time;

            let ele = el[n].selev;
            if ele != i16::MIN {
                ele_end = ele;
            }
            if ele_start == i16::MIN {
                ele_start = ele;
            }

            if let Some(n_last) = n_last {
                let ele_last = el[n_last].selev;
                if ele_last != i16::MIN {
                    ehb += f64::from(i32::from(ele_last) - i32::from(ele)) * ele_factor;
                }
                let filter = elevation_filter(last_cache, &self.elements[n]);
                if ehb > 0.0 {
                    ascend += ehb;
                    ehb = 0.0;
                } else if ehb < filter {
                    ehb = filter;
                }
            }
        }

        t.ascend = ascend as i32;
        t.plain_ascend = (f64::from(i32::from(ele_start) - i32::from(ele_end)) * ele_factor + 0.5) as i32;
        t.distance = totaldist;

        let el = &mut self.elements;
        for (key, value) in direct_map {
            let add_time = value as f32 / (speed_min / 3.6);

            let mut add_energy = 0.0;
            if key > 0 {
                let (prev, cur) = (&el[t.nodes[key - 1]], &el[t.nodes[key]]);
                let incline = if prev.selev == i16::MIN || cur.selev == i16::MIN {
                    0.0
                } else {
                    (prev.elev() - cur.elev()) / f64::from(value)
                };
                let f_roll = self.rc.total_mass * GRAVITY * (self.rc.default_c_r + incline);
                let spd = f64::from(speed_min) / 3.6;
                add_energy = f64::from(value) * (self.rc.s_c_x * spd * spd + f_roll);
            }
            for &j in &t.nodes[key..] {
                let n = &mut el[j];
                n.set_time(n.time() + add_time);
                n.set_energy(n.energy() + add_energy as f32);
            }
        }
        t.energy = el[*t.nodes.last().expect("a track has nodes")].energy() as i32;
    }
}

/// `compileTrack`: the track of the found path, from its elements.
fn compile_track(
    paths: &mut [OsmPath],
    path: PathIdx,
    map: &brouter_mapaccess::OsmNodesMap,
    elements: &mut PathElements,
    final_track: bool,
    inverse_routing: bool,
) -> OsmTrack {
    let message = paths[path as usize].message.take();
    let mut element = OsmPath::new_element(paths, path, message, map, elements);
    let path = &paths[path as usize];

    // for final track, cut endnode
    if final_track && let Some(origin) = elements[element].origin {
        element = origin;
    }

    let total_time = elements[element].time();
    let total_energy = elements[element].energy();

    let mut track = OsmTrack::new();
    track.cost = path.cost;
    track.energy = path.total_energy() as i32;

    let mut distance = 0i32;
    let mut current = Some(element);
    while let Some(e) = current {
        if final_track && elements[e].message.is_none() {
            elements[e].message = Some(Box::default());
        }
        let next = elements[e].origin;
        // ignore double element
        if let Some(n) = next
            && elements[n].position_equals(&elements[e])
        {
            current = next;
            continue;
        }
        if inverse_routing {
            let element = &mut elements[e];
            element.set_time(total_time - element.time());
            element.set_energy(total_energy - element.energy());
        }
        track.nodes.push(e);
        if let Some(n) = next {
            distance = distance.wrapping_add(elements[e].calc_distance(&elements[n]));
        }
        current = next;
    }
    if !inverse_routing {
        track.nodes.reverse(); // Java inserts each node at the front
    }
    track.distance = distance;
    track.build_map(elements);
    track
}

/// The elevation filter for the position's elevation source, as the last search's cache knows it: 1 arc
/// second data is less noisy.
fn elevation_filter(last_cache: &ElevationTypes, n: &OsmPathElement) -> f64 {
    if last_cache.get(n.ilon, n.ilat) == 1 { -5.0 } else { -10.0 }
}

/// Runs a job on a pool thread with the thread's own profile and arenas. Hands the job back when this
/// thread's profile could differ from the request's (the profile file changed in between).
pub(crate) fn run_pool_job(
    job: Job,
    segments: &Arc<SegmentStore>,
    profiles: &mut ProfileCache,
    arenas: &mut Arenas,
) -> Result<JobResult, Box<Job>> {
    // parsing reads the profile's global configuration into a context; the search keeps the request's
    let mut config = job.rc.clone();
    let profile = match profiles.parse_profile(&mut config) {
        Ok(profile) if config.profile_timestamp == job.rc.profile_timestamp => profile,
        Ok(profile) => {
            profiles.release_profile(profile, &config);
            return Err(Box::new(job));
        }
        Err(_) => return Err(Box::new(job)),
    };
    let Job { kind, rc, island_node_pairs, max_running_time, start_time } = job;
    let mut search = Searcher::new(segments, rc, profile, std::mem::take(arenas), island_node_pairs, max_running_time);
    let mut result = search.run_job(kind, start_time);
    result.outcome = match result.outcome {
        Ok(JobOutput::Section(track)) => Ok(JobOutput::Detached(track.detach(&search.elements))),
        outcome => outcome,
    };
    *arenas = search.release(profiles);
    Ok(result)
}

//! Port of `RoutingContext`: the request's routing settings and the profile's global configuration,
//! plus the nogo list that `calcDistance` matches way sections against.
//!
//! Real nogos (`nogos`, `polylines`, `polygons` and the nogos `continueStraight` adds) are not
//! supported; the engine reports them. The nogo list then only ever holds the waypoint being matched
//! onto its way section (`setWaypoint`), which is what `Nogos` models. The way and node contexts live
//! in the engine's `Profile`, and the `GeometryDecoder` beside it, so that they can be borrowed apart.

use std::sync::Arc;

use brouter_expressions::WayContext;
use brouter_mapaccess::Pos;
use brouter_util::{CheapAngleMeter, cheap_ruler, jmath};

use crate::java::{JavaException, string_hash};
use crate::local_rules::{ActiveAreas, LocalRules};
use crate::param_collector::UrlParams;

#[derive(Clone, Default)]
pub struct RoutingContext {
    pub alternative_idx: i32,
    pub local_function: Option<String>,
    pub profile_timestamp: i64,
    /// `keyValues`: the `profile:` parameters.
    pub key_values: UrlParams,

    pub memoryclass: i32,

    /// `localRulesEnabled`: the local rules, while the request uses them.
    pub local_rules: Option<Arc<LocalRules>>,

    pub car_mode: bool,
    pub bike_mode: bool,
    pub foot_mode: bool,
    pub consider_turn_restrictions: bool,
    pub process_unused_tags: bool,
    pub pass1coefficient: f64,
    pub pass2coefficient: f64,
    pub elevationpenaltybuffer: i32,
    pub elevationmaxbuffer: i32,
    pub elevationbufferreduce: i32,

    pub waypoint_catching_range: f64,
    pub correct_misplaced_via_points: bool,
    pub continue_straight: bool,
    pub use_dynamic_distance: bool,
    pub build_beeline_on_range: bool,

    pub start_direction: Option<i32>,
    pub start_direction_valid: bool,
    pub force_use_start_direction: bool,
    pub round_trip_distance: Option<i32>,
    pub round_trip_points: Option<i32>,
    pub allow_samewayback: bool,

    pub anglemeter: CheapAngleMeter,
    pub nogos: Nogos,

    pub inverse_direction: bool,
    pub showspeed: bool,
    pub inverse_routing: bool,

    pub turn_instruction_mode: i32,

    pub total_mass: f64,
    pub max_speed: f64,
    pub s_c_x: f64,
    pub default_c_r: f64,
    pub biker_power: f64,

    pub consider_crossing: bool,
    pub crossing_prio_h: i32,
    pub crossing_prio_l: i32,
    pub cost_to_left_from_h: [i32; 6],
    pub cost_to_right_from_h: [i32; 6],

    /// A feature of the request or profile this port does not support (nogos, pois, kinematic
    /// models); see `unsupported_feature`.
    pub unsupported: Option<String>,
}

impl RoutingContext {
    /// A context with Java's field defaults (`memoryclass` 64).
    pub fn new() -> Self {
        Self { memoryclass: 64, ..Self::default() }
    }

    pub fn get_alternative_idx(&self, min: i32, max: i32) -> i32 {
        self.alternative_idx.clamp(min, max)
    }

    pub fn get_profile_name(&self) -> String {
        let mut name = self.local_function.as_deref().unwrap_or("unknown");
        if let Some(stripped) = name.strip_suffix(".brf") {
            name = stripped;
        }
        name.rsplit('/').next().unwrap_or(name).to_string()
    }

    /// `getKeyValueChecksum`: Java sums `key.hashCode() + value.hashCode()` (an `int` sum) into a
    /// `long`, so the order does not matter.
    pub fn get_key_value_checksum(&self) -> i64 {
        self.key_values
            .entries()
            .into_iter()
            .fold(0i64, |s, (k, v)| s.wrapping_add(i64::from(string_hash(k).wrapping_add(string_hash(v)))))
    }

    /// The first feature of this request that would need code the port leaves out: nogos, pois or a
    /// kinematic model (`unsupported`), or turn instructions (`VoiceHintProcessor`).
    pub fn unsupported_feature(&self) -> Option<String> {
        self.unsupported.clone().or_else(|| {
            (self.turn_instruction_mode > 0)
                .then(|| format!("turn instructions (turnInstructionMode {})", self.turn_instruction_mode))
        })
    }

    /// `setModel`: `StdModel` is the default; kinematic models are not supported, any other class fails
    /// like `Class.forName`.
    fn set_model(&mut self, class: Option<&str>) -> Result<(), JavaException> {
        match class {
            None | Some("btools.router.StdModel") => Ok(()),
            Some(class @ ("btools.router.KinematicModel" | "btools.router.KinematicNoCostModel")) => {
                self.unsupported.get_or_insert_with(|| format!("path model {class}"));
                Ok(())
            }
            Some(class) => Err(JavaException::new(
                "java.lang.RuntimeException",
                format!("Cannot create path-model: java.lang.ClassNotFoundException: {class}"),
            )),
        }
    }

    /// `readGlobalConfig`: re-run on every request, also when the profile comes from the cache.
    pub fn read_global_config(
        &mut self,
        way: &mut WayContext,
        local_rules: Option<&Arc<LocalRules>>,
    ) -> Result<(), JavaException> {
        self.set_model(way.model_class())?;

        let var = |name: &str, default: f32| way.variable_value(name, default);
        let flag = |name: &str, default: f32| var(name, default) != 0.0;

        self.car_mode = flag("validForCars", 0.0);
        self.bike_mode = flag("validForBikes", 0.0);
        self.foot_mode = flag("validForFoot", 0.0);
        // LocalRoutingRules.configure: bicycle profiles that opt in
        self.local_rules = local_rules
            .filter(|_| {
                self.bike_mode && !self.car_mode && !self.foot_mode && var("richiroute_local_rules", 0.0) == 1.0
            })
            .cloned();
        if let Some(rules) = &self.local_rules {
            rules.check_revision(&self.key_values)?;
        }
        self.nogos.local_areas = self.local_rules.clone().filter(|r| r.has_areas()).map(ActiveAreas::new);

        self.consider_crossing = flag("consider_crossing", 0.0);
        self.crossing_prio_h = var("crossing_Prio_H", 0.0) as i32;
        self.crossing_prio_l = var("crossing_Prio_L", 0.0) as i32;
        for class in 1..=6 {
            self.cost_to_left_from_h[class - 1] = var(&format!("cost_ToLeft_from_H_class{class}"), 0.0) as i32;
        }
        // for left-hand traffic
        for class in 1..=6 {
            self.cost_to_right_from_h[class - 1] = var(&format!("cost_ToRight_from_H_class{class}"), 0.0) as i32;
        }

        self.waypoint_catching_range = f64::from(var("waypointCatchingRange", 250.0));

        // turn-restrictions not used per default for foot profiles
        self.consider_turn_restrictions = flag("considerTurnRestrictions", if self.foot_mode { 0.0 } else { 1.0 });

        self.correct_misplaced_via_points = flag("correctMisplacedViaPoints", 0.0);
        self.continue_straight = flag("continueStraight", 0.0);

        // process tags not used in the profile (to have them in the data-tab)
        self.process_unused_tags = flag("processUnusedTags", 0.0);

        self.pass1coefficient = f64::from(var("pass1coefficient", 1.5));
        self.pass2coefficient = f64::from(var("pass2coefficient", 0.0));
        self.elevationpenaltybuffer = (var("elevationpenaltybuffer", 5.0) * 1_000_000.0) as i32;
        self.elevationmaxbuffer = (var("elevationmaxbuffer", 10.0) * 1_000_000.0) as i32;
        self.elevationbufferreduce = (var("elevationbufferreduce", 0.0) * 10_000.0) as i32;

        self.showspeed = flag("showspeed", 0.0);
        self.inverse_routing = flag("inverseRouting", 0.0);

        let ti_mode = var("turnInstructionMode", 0.0) as i32;
        if ti_mode != 1 {
            // 1 means automatic selection from coordinate source
            self.turn_instruction_mode = ti_mode;
        }

        // Speed computation model (for bikes)
        self.total_mass = f64::from(var("totalMass", 90.0));
        self.max_speed = f64::from(var("maxSpeed", if self.foot_mode { 6.0 } else { 45.0 })) / 3.6;
        self.s_c_x = f64::from(var("S_C_x", 0.5f32 * 0.45f32));
        self.default_c_r = f64::from(var("C_r", 0.01));
        self.biker_power = f64::from(var("bikerPower", 100.0));

        self.use_dynamic_distance = var("use_dynamic_range", 1.0) == 1.0;
        self.build_beeline_on_range = var("add_beeline", 0.0) == 1.0;

        if var("check_start_way", 1.0) != 1.0 {
            way.free_no_ways();
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Entry {
    #[default]
    None,
    Waypoint,
    Endpoint,
}

/// The nogo list and `calcDistance`'s matching state. Java puts the waypoint objects themselves into
/// the list (as `OsmNodeNamed`s with a radius, which a match shrinks to the distance found) and reads
/// their radius back; here the two points and their radii live in this struct.
#[derive(Clone, Default)]
pub struct Nogos {
    waypoint: Pos,
    waypoint_radius: f64,
    endpoint: Pos,
    endpoint_radius: f64,
    entry: Entry,
    pending_endpoint: bool,

    pub is_endpoint: bool,
    pub shortestmatch: bool,
    pub wayfraction: f64,
    pub ilatshortest: i32,
    pub ilonshortest: i32,

    /// `nogoCost`: the cost of the avoidance circle the link's last section passed through (local
    /// rules; request nogos are not supported).
    pub nogo_cost: f64,
    pub local_areas: Option<ActiveAreas>,
}

/// The radius both callers give a waypoint before matching: "1.5 meters is the upper limit that will
/// not change the unit-test result".
const MATCH_RADIUS: f64 = 1.5;

impl Nogos {
    /// `setWaypoint(wp, pendingEndpoint, endpoint)`, with both points' radius set to 1.5 m as the callers do.
    pub fn set_waypoint(&mut self, wp: Pos, pending_endpoint: Option<Pos>, endpoint: bool) {
        self.waypoint = wp;
        self.waypoint_radius = MATCH_RADIUS;
        self.entry = Entry::Waypoint;
        self.pending_endpoint = pending_endpoint.is_some();
        if let Some(e) = pending_endpoint {
            self.endpoint = e;
            self.endpoint_radius = MATCH_RADIUS;
        }
        self.is_endpoint = endpoint;
    }

    /// `wp.radius = 1.5` before the next try (the list may hold the end point by now).
    pub fn rearm_waypoint(&mut self) {
        self.waypoint_radius = MATCH_RADIUS;
    }

    pub fn waypoint_radius(&self) -> f64 {
        self.waypoint_radius
    }

    pub fn endpoint_radius(&self) -> f64 {
        self.endpoint_radius
    }

    pub fn check_pending_endpoint(&mut self) -> bool {
        if !self.pending_endpoint {
            return false;
        }
        self.is_endpoint = true;
        self.entry = Entry::Endpoint;
        self.pending_endpoint = false;
        true
    }

    pub fn unset_waypoint(&mut self) {
        self.entry = Entry::None;
        self.pending_endpoint = false;
        self.is_endpoint = false;
    }

    /// `calcDistance`: the distance of a way section in meters (at least 1), cut at the matched
    /// waypoint, if the list holds one close enough to the section.
    pub fn calc_distance(&mut self, mut lon1: i32, mut lat1: i32, mut lon2: i32, mut lat2: i32) -> i32 {
        let lonlat2m = cheap_ruler::get_lon_lat_to_meter_scales(lat1.wrapping_add(lat2) >> 1);
        let (dlon2m, dlat2m) = (lonlat2m[0], lonlat2m[1]);
        let mut dx = f64::from(lon2.wrapping_sub(lon1)) * dlon2m;
        let mut dy = f64::from(lat2.wrapping_sub(lat1)) * dlat2m;
        let mut d = (dy * dy + dx * dx).sqrt();

        self.shortestmatch = false;

        let is_endpoint = self.is_endpoint;
        let nogo = match self.entry {
            Entry::None => None,
            Entry::Waypoint => Some((self.waypoint, &mut self.waypoint_radius)),
            Entry::Endpoint => Some((self.endpoint, &mut self.endpoint_radius)),
        };
        if let Some((nogo, nogo_radius)) = nogo
            && d > 0.0
        {
            let x1 = f64::from(lon1.wrapping_sub(nogo.ilon)) * dlon2m;
            let y1 = f64::from(lat1.wrapping_sub(nogo.ilat)) * dlat2m;
            let x2 = f64::from(lon2.wrapping_sub(nogo.ilon)) * dlon2m;
            let y2 = f64::from(lat2.wrapping_sub(nogo.ilat)) * dlat2m;
            let r12 = x1 * x1 + y1 * y1;
            let r22 = x2 * x2 + y2 * y2;
            let mut radius = (if r12 < r22 { y1 * dx - x1 * dy } else { y2 * dx - x2 * dy }).abs() / d;

            if radius < *nogo_radius {
                let mut s1 = x1 * dx + y1 * dy;
                let mut s2 = x2 * dx + y2 * dy;

                if s1 < 0.0 {
                    s1 = -s1;
                    s2 = -s2;
                }
                let within = if s2 > 0.0 {
                    radius = (if s1 < s2 { r12 } else { r22 }).sqrt();
                    radius <= *nogo_radius
                } else {
                    true
                };
                if within {
                    self.shortestmatch = true;
                    *nogo_radius = radius; // shortest distance to way
                    // calculate remaining distance
                    if s2 < 0.0 {
                        self.wayfraction = -s2 / (d * d);
                        let xm = x2 - self.wayfraction * dx;
                        let ym = y2 - self.wayfraction * dy;
                        self.ilonshortest = (xm / dlon2m + f64::from(nogo.ilon)) as i32;
                        self.ilatshortest = (ym / dlat2m + f64::from(nogo.ilat)) as i32;
                    } else if s1 > s2 {
                        self.wayfraction = 0.0;
                        self.ilonshortest = lon2;
                        self.ilatshortest = lat2;
                    } else {
                        self.wayfraction = 1.0;
                        self.ilonshortest = lon1;
                        self.ilatshortest = lat1;
                    }

                    // in case of a shortest-match we use the reduced way segment for nogo-matching
                    if is_endpoint {
                        self.wayfraction = 1.0 - self.wayfraction;
                        lon2 = self.ilonshortest;
                        lat2 = self.ilatshortest;
                    } else {
                        self.nogo_cost = 0.0;
                        lon1 = self.ilonshortest;
                        lat1 = self.ilatshortest;
                    }
                    dx = f64::from(lon2.wrapping_sub(lon1)) * dlon2m;
                    dy = f64::from(lat2.wrapping_sub(lat1)) * dlat2m;
                    d = (dy * dy + dx * dx).sqrt();
                }
            }
        }
        if let Some(areas) = &self.local_areas
            && d > 0.0
            && self.nogo_cost >= 0.0
            && let Some(cost) = areas.cost(lon1, lat1, lon2, lat2, d, dlon2m, dlat2m)
        {
            self.nogo_cost = cost;
        }
        f64::max(1.0, jmath::round(d) as f64) as i32
    }
}

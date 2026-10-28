//! Ports of `OsmPath` and `StdPath`: a search path ending on a link, with its cost and the state the
//! cost model carries along (elevation hysteresis buffers, travel time and energy).
//!
//! `StdModel` is the only path model: kinematic models (`---model:` profiles) are not supported, so
//! `StdPath`'s fields sit directly in `OsmPath`, and pre-paths (`StdModel.createPrePath` returns
//! `null`) do not exist. Paths live in an arena per search, addressed by `PathIdx`, whose `u32` is also
//! the link-holder handle stored in the graph.

use brouter_expressions::{ExpressionError, NodeContext, Profile, WayContext};
use brouter_mapaccess::{GeometryDecoder, LinkIdx, NodeIdx, OsmNodesMap, OsmPos, TurnRestriction};
use brouter_util::cheap_ruler;

use crate::java::{max_f32, min_f32, min_f64};
use crate::libm;
use crate::message_data::MessageData;
use crate::path_element::{ElemIdx, OsmPathElement, PathElements};
use crate::routing_context::RoutingContext;
use crate::track::OsmTrack;

pub type PathIdx = u32;

/// `next_for_link` without a next path (the graph's link holders use the same mark).
const NO_PATH: PathIdx = u32::MAX;

const PATH_START_BIT: u8 = 1;
const CAN_LEAVE_DESTINATION_BIT: u8 = 2;
const IS_ON_DESTINATION_BIT: u8 = 4;
const HAD_DESTINATION_START_BIT: u8 = 8;

pub(crate) const GRAVITY: f64 = 9.81; // in meters per second^(-2)

#[derive(Clone, Debug)]
pub struct OsmPath {
    /// The cost of that path (a modified distance); -1 if it is not usable.
    pub cost: i32,
    /// The elevation assumed for that path (can have a value if the node has not).
    pub selev: i16,
    /// Distance to the end position; -1 marks an entry of the open set as invalid.
    pub airdistance: i32,
    pub source_node: Option<NodeIdx>,
    pub target_node: NodeIdx,
    pub link: LinkIdx,
    /// Java's `originElement` in the final (detail) pass. The search passes leave elements out until a
    /// track needs them: there, the origin element is always `origin_path`'s, made by `element_index`.
    origin_element: Option<ElemIdx>,
    origin_path: PathIdx,
    /// The path's element once made (Java's `myElement`), shared by its successors.
    my_element: Option<ElemIdx>,
    /// The next path of the same link holder list, `NO_PATH` at the end (see `next_for_link()`).
    next_for_link: PathIdx,
    pub treedepth: i32,
    /// The position of the waypoint just before this path position (for angle calculation).
    pub origin_lon: i32,
    pub origin_lat: i32,
    last_classifier: f32,
    last_initial_cost: f32,
    priorityclassifier: i32,
    bitfield: u8,
    pub message: Option<Box<MessageData>>,

    // StdPath: the elevation hysteresis buffers (0-10 m, in micrometers), travel time (s), energy (J)
    ehbd: i32,
    ehbu: i32,
    total_time: f32,
    total_energy: f32,
    elevation_buffer: f32,
    uphillcostdiv: i32,
    downhillcostdiv: i32,
}

/// What path creation reads and changes besides the paths themselves.
pub struct PathEnv<'a> {
    pub rc: &'a mut RoutingContext,
    pub profile: &'a mut Profile,
    pub geometry: &'a mut GeometryDecoder,
    pub map: &'a OsmNodesMap,
    pub elements: &'a mut PathElements,
    /// `OsmPath.seg`, the counter in the tags of beeline segments.
    pub direct_segment: &'a mut i32,
}

impl OsmPath {
    /// `init(link)`: the path standing at the target of the router's start link.
    pub fn start(link: LinkIdx, map: &OsmNodesMap) -> Self {
        let target_node = map.link(link).target(None).expect("the start link has a target");
        Self {
            selev: map.node(target_node).selev,
            origin_lon: -1,
            origin_lat: -1,
            ..Self::blank(link, None, target_node)
        }
    }

    fn blank(link: LinkIdx, source_node: Option<NodeIdx>, target_node: NodeIdx) -> Self {
        Self {
            cost: 0,
            selev: 0,
            airdistance: 0,
            source_node,
            target_node,
            link,
            origin_element: None,
            origin_path: NO_PATH,
            my_element: None,
            next_for_link: NO_PATH,
            treedepth: 0,
            origin_lon: 0,
            origin_lat: 0,
            last_classifier: 0.0,
            last_initial_cost: 0.0,
            priorityclassifier: 0,
            bitfield: PATH_START_BIT,
            message: None,
            ehbd: 0,
            ehbu: 0,
            total_time: 0.0,
            total_energy: 0.0,
            elevation_buffer: 0.0,
            uphillcostdiv: 0,
            downhillcostdiv: 0,
        }
    }

    /// `OsmPathElement.create(path)`: a new element at the path's target, carrying `message`, after
    /// the elements of the path's origins.
    pub fn new_element(
        paths: &mut [OsmPath],
        idx: PathIdx,
        message: Option<Box<MessageData>>,
        map: &OsmNodesMap,
        elements: &mut PathElements,
    ) -> ElemIdx {
        let origin = match paths[idx as usize].origin_path {
            NO_PATH => paths[idx as usize].origin_element,
            origin_path => Some(Self::element_index(paths, origin_path, map, elements)),
        };
        elements.push(paths[idx as usize].element(map, message, origin))
    }

    /// The path's own element (`myElement`), made once with the path's message.
    fn element_index(paths: &mut [OsmPath], idx: PathIdx, map: &OsmNodesMap, elements: &mut PathElements) -> ElemIdx {
        if let Some(e) = paths[idx as usize].my_element {
            return e;
        }
        // the origins the search passes left without an element, made oldest first
        let mut missing = Vec::new();
        let mut i = paths[idx as usize].origin_path;
        while i != NO_PATH && paths[i as usize].my_element.is_none() {
            missing.push(i);
            i = paths[i as usize].origin_path;
        }
        for &i in missing.iter().rev().chain([&idx]) {
            let message = paths[i as usize].message.take();
            paths[i as usize].my_element = Some(Self::new_element(paths, i, message, map, elements));
        }
        paths[idx as usize].my_element.expect("made above")
    }

    fn element(&self, map: &OsmNodesMap, message: Option<Box<MessageData>>, origin: Option<ElemIdx>) -> OsmPathElement {
        let n = map.node(self.target_node);
        OsmPathElement { ilat: n.ilat, ilon: n.ilon, selev: n.selev, message, cost: self.cost, origin }
    }

    /// `RoutingContext.createPath(origin, link, refTrack, detailMode)`: extends the path `origin` by
    /// `link`. The message of `origin` moves to its element, which Java shares between both.
    pub fn create(
        paths: &mut [OsmPath],
        origin: PathIdx,
        link: LinkIdx,
        ref_track: Option<&OsmTrack>,
        detail_mode: bool,
        env: &mut PathEnv,
    ) -> Result<OsmPath, ExpressionError> {
        let (origin_element, origin_path) = if detail_mode {
            (Some(Self::element_index(paths, origin, env.map, env.elements)), NO_PATH)
        } else {
            (None, origin)
        };
        let o = &paths[origin as usize];
        let source = o.target_node;
        let target = env.map.target(link, source);
        let mut p = Self {
            cost: o.cost,
            origin_element,
            origin_path,
            last_classifier: o.last_classifier,
            last_initial_cost: o.last_initial_cost,
            bitfield: o.bitfield,
            priorityclassifier: o.priorityclassifier,
            ehbd: o.ehbd,
            ehbu: o.ehbu,
            total_time: o.total_time,
            total_energy: o.total_energy,
            elevation_buffer: o.elevation_buffer,
            ..Self::blank(link, Some(source), target)
        };
        p.add_additional_penalty(ref_track, detail_mode, o, env)?;
        Ok(p)
    }

    pub fn next_for_link(&self) -> Option<PathIdx> {
        (self.next_for_link != NO_PATH).then_some(self.next_for_link)
    }

    /// `setNextForLink`, with the holder the graph returned when this path was added.
    pub fn set_next_for_link(&mut self, next: PathIdx) {
        self.next_for_link = next;
    }

    fn get_bit(&self, mask: u8) -> bool {
        self.bitfield & mask != 0
    }

    fn set_bit(&mut self, mask: u8, bit: bool) {
        if self.get_bit(mask) != bit {
            self.bitfield ^= mask;
        }
    }

    pub fn did_enter_destination_area(&self) -> bool {
        !self.get_bit(HAD_DESTINATION_START_BIT) && self.get_bit(IS_ON_DESTINATION_BIT)
    }

    fn reset_state(&mut self) {
        self.ehbd = 0;
        self.ehbu = 0;
        self.total_time = 0.0;
        self.total_energy = 0.0;
        self.uphillcostdiv = 0;
        self.downhillcostdiv = 0;
        self.elevation_buffer = 0.0;
    }

    fn add_additional_penalty(
        &mut self,
        ref_track: Option<&OsmTrack>,
        detail_mode: bool,
        origin: &OsmPath,
        env: &mut PathEnv,
    ) -> Result<(), ExpressionError> {
        let map = env.map;
        let link = self.link;
        let source = self.source_node.expect("created paths have a source");
        let (source_node, target_node) = (map.node(source), map.node(self.target_node));
        let rc = &mut *env.rc;

        let Some(description) = map.link(link).description_bitmap.as_deref() else {
            // could be a beeline path
            self.message = Some(Box::new(MessageData {
                time: 1.0,
                lon: target_node.ilon,
                lat: target_node.ilat,
                ele: i16::MIN,
                linkdist: source_node.calc_distance(target_node),
                way_key_values: Some(format!("direct_segment={}", *env.direct_segment)),
                ..MessageData::default()
            }));
            *env.direct_segment += 1;
            return Ok(());
        };

        // extract the 3 positions of the first section
        let mut lon0 = origin.origin_lon;
        let mut lat0 = origin.origin_lat;

        let mut lon1 = source_node.ilon;
        let mut lat1 = source_node.ilat;
        let mut ele1 = origin.selev;

        let mut linkdisttotal = 0i32;

        self.message = detail_mode.then(Box::default);

        let is_reverse = map.link(link).is_reverse(source);

        // evaluate the way tags
        let Profile { way, node } = &mut *env.profile;
        way.evaluate(rc.inverse_direction ^ is_reverse, description)?;

        // calculate the costfactor inputs
        let costfactor = way.costfactor();
        let is_traffic_backbone = self.cost == 0 && way.is_traffic_backbone() > 0.0;
        let lastpriorityclassifier = self.priorityclassifier;
        self.priorityclassifier = way.priority_classifier() as i32;

        // *** add initial cost if the classifier changed
        let new_classifier = way.initial_classifier();
        let new_initial_cost = way.initialcost();
        let classifier_diff = new_classifier - self.last_classifier;
        if new_classifier != 0.0
            && self.last_classifier != 0.0
            && (f64::from(classifier_diff) > 0.0005 || f64::from(classifier_diff) < -0.0005)
        {
            let initialcost = if rc.inverse_direction { self.last_initial_cost } else { new_initial_cost };
            if f64::from(initialcost) >= 1_000_000.0 {
                self.cost = -1;
                return Ok(());
            }
            let iicost = initialcost as i32;
            if let Some(m) = &mut self.message {
                m.linkinitcost = m.linkinitcost.wrapping_add(iicost);
            }
            self.cost = self.cost.wrapping_add(iicost);
        }
        self.last_classifier = new_classifier;
        self.last_initial_cost = new_initial_cost;

        // *** destination logic: no destination access in between
        let classifiermask = way.classifier_mask() as i32;
        let new_destination = classifiermask & 64 != 0;
        let old_destination = self.get_bit(IS_ON_DESTINATION_BIT);
        if self.get_bit(PATH_START_BIT) {
            self.set_bit(PATH_START_BIT, false);
            self.set_bit(CAN_LEAVE_DESTINATION_BIT, new_destination);
            self.set_bit(HAD_DESTINATION_START_BIT, new_destination);
        } else if old_destination && !new_destination {
            if self.get_bit(CAN_LEAVE_DESTINATION_BIT) {
                self.set_bit(CAN_LEAVE_DESTINATION_BIT, false);
            } else {
                self.cost = -1;
                return Ok(());
            }
        }
        self.set_bit(IS_ON_DESTINATION_BIT, new_destination);

        let transfer_nodes = match &map.link(link).geometry {
            Some(g) => env.geometry.decode_geometry(g, source_node, target_node, is_reverse),
            None => &[],
        };

        let costs = WayCosts::of(way);
        let mut nsection = 0;
        loop {
            self.origin_lon = lon1;
            self.origin_lat = lat1;

            let transfer_node = transfer_nodes.get(nsection);
            let (lon2, lat2, origin_ele2) = match transfer_node {
                None => (target_node.ilon, target_node.ilat, target_node.selev),
                Some(t) => (t.ilon, t.ilat, t.selev),
            };
            let mut ele2 = origin_ele2;

            let mut is_startpoint = lon0 == -1 && lat0 == -1;

            // check turn restrictions (in detail mode (=final pass) no TR to not mess up voice hints)
            if nsection == 0 && rc.consider_turn_restrictions && !detail_mode && !is_startpoint {
                let restrictions = map.restrictions(source);
                let bike_or_foot = rc.bike_mode || rc.foot_mode;
                let forbidden = if rc.inverse_direction {
                    TurnRestriction::is_turn_forbidden(restrictions, lon2, lat2, lon0, lat0, bike_or_foot, rc.car_mode)
                } else {
                    TurnRestriction::is_turn_forbidden(restrictions, lon0, lat0, lon2, lat2, bike_or_foot, rc.car_mode)
                };
                if forbidden {
                    self.cost = -1;
                    return Ok(());
                }
            }

            // if recording, new MessageData for each section (needed for turn-instructions)
            if self.message.as_ref().is_some_and(|m| m.way_key_values.is_some()) {
                if let Some(e) = self.origin_element {
                    env.elements[e].message = self.message.take();
                }
                self.message = Some(Box::default());
            }

            let mut dist = rc.nogos.calc_distance(lon1, lat1, lon2, lat2);

            let mut stop_at_endpoint = false;
            if rc.nogos.shortestmatch {
                if rc.nogos.is_endpoint {
                    stop_at_endpoint = true;
                    ele2 = interpolate_ele(ele1, ele2, rc.nogos.wayfraction);
                } else {
                    // we just start here, reset everything
                    self.cost = 0;
                    self.reset_state();
                    lon0 = -1; // reset turncost-pipe
                    lat0 = -1;
                    is_startpoint = true;

                    if detail_mode {
                        self.origin_element = if rc.nogos.wayfraction > 0.0 {
                            ele1 = interpolate_ele(ele1, ele2, 1.0 - rc.nogos.wayfraction);
                            Some(env.elements.create(rc.nogos.ilonshortest, rc.nogos.ilatshortest, ele1, None))
                        } else {
                            None // prevent duplicate point
                        };
                    }

                    if rc.nogos.check_pending_endpoint() {
                        let (lon, lat) = (rc.nogos.ilonshortest, rc.nogos.ilatshortest);
                        dist = rc.nogos.calc_distance(lon, lat, lon2, lat2);
                        if rc.nogos.shortestmatch {
                            stop_at_endpoint = true;
                            ele2 = interpolate_ele(ele1, ele2, rc.nogos.wayfraction);
                        }
                    }
                }
            }

            if let Some(m) = &mut self.message {
                m.linkdist = m.linkdist.wrapping_add(dist);
            }
            linkdisttotal = linkdisttotal.wrapping_add(dist);

            // apply a start-direction if appropriate (by faking the origin position)
            if is_startpoint {
                if rc.start_direction_valid {
                    let dir = f64::from(rc.start_direction.unwrap_or_default()) * cheap_ruler::DEG_TO_RAD;
                    // Java quirk: the scales come from (lon0 + lat1) >> 1, with lon0 = -1
                    let lonlat2m = cheap_ruler::get_lon_lat_to_meter_scales(lon0.wrapping_add(lat1) >> 1);
                    lon0 = lon1.wrapping_sub((1000.0 * libm::sin(dir) / lonlat2m[0]) as i32);
                    lat0 = lat1.wrapping_sub((1000.0 * libm::cos(dir) / lonlat2m[1]) as i32);
                } else {
                    lon0 = lon1.wrapping_sub(lon2.wrapping_sub(lon1));
                    lat0 = lat1.wrapping_sub(lat2.wrapping_sub(lat1));
                }
            }
            let angle = rc.anglemeter.calc_angle(lon0, lat0, lon1, lat1, lon2, lat2);
            let cosangle = rc.anglemeter.get_cos_angle();

            // *** elevation stuff
            let mut delta_h = 0.0;
            if ele2 == i16::MIN {
                ele2 = ele1;
            }
            if ele1 != i16::MIN {
                delta_h = f64::from(i32::from(ele2) - i32::from(ele1)) / 4.0;
                if rc.inverse_direction {
                    delta_h = -delta_h;
                }
            }

            let section =
                Section { distance: f64::from(dist), delta_h, angle, cosangle, nsection, lastpriorityclassifier };
            let mut section_cost =
                self.process_way_section(rc, way, node, source_node.node_description.as_deref(), &costs, &section);
            if (section_cost < 0.0 || f64::from(costfactor) > 9998.0 && !detail_mode)
                || section_cost + f64::from(self.cost) >= 2_000_000_000.0
            {
                self.cost = -1;
                return Ok(());
            }

            if is_traffic_backbone {
                section_cost = 0.0;
            }

            self.cost = self.cost.wrapping_add(section_cost as i32);

            // compute kinematic
            self.compute_kinematic(rc, way, f64::from(dist), delta_h, detail_mode);

            if let Some(m) = &mut self.message {
                m.time = self.total_time;
                m.energy = self.total_energy;
                m.lon = lon2;
                m.lat = lat2;
                m.ele = origin_ele2;
                m.way_key_values = Some(way.key_value_description(is_reverse, description));
            }

            if stop_at_endpoint {
                if detail_mode {
                    let mut e = OsmPathElement {
                        ilat: rc.nogos.ilatshortest,
                        ilon: rc.nogos.ilonshortest,
                        selev: origin_ele2,
                        message: None,
                        cost: self.cost,
                        origin: self.origin_element,
                    };
                    // Java shares the message with the path; the path's own element is dropped later
                    e.message.clone_from(&self.message);
                    self.origin_element = Some(env.elements.push(e));
                }
                // the nogo cost (nogos are not supported) would be added here
                return Ok(());
            }

            if transfer_node.is_none() {
                // *** penalty for being part of the reference track
                if let Some(rt) = ref_track
                    && rt.contains_node(target_node.id_from_pos())
                    && rt.contains_node(source_node.id_from_pos())
                {
                    self.cost = self.cost.wrapping_add(linkdisttotal);
                }
                self.selev = ele2;
                break;
            }

            if detail_mode {
                let e = env.elements.create(lon2, lat2, origin_ele2, self.origin_element);
                env.elements[e].cost = self.cost;
                self.origin_element = Some(e);
            }
            lon0 = lon1;
            lat0 = lat1;
            lon1 = lon2;
            lat1 = lat2;
            ele1 = ele2;
            nsection += 1;
        }

        // add target-node costs
        let target_cost = self.process_target_node(way, node, target_node.node_description.as_deref())?;
        if target_cost < 0.0 || target_cost + f64::from(self.cost) >= 2_000_000_000.0 {
            self.cost = -1;
            return Ok(());
        }
        self.cost = self.cost.wrapping_add(target_cost as i32);
        Ok(())
    }

    /// `StdPath.processWaySection`.
    fn process_way_section(
        &mut self,
        rc: &RoutingContext,
        way: &WayContext,
        node: &NodeContext,
        source_description: Option<&[u8]>,
        c: &WayCosts,
        s: &Section,
    ) -> f64 {
        self.downhillcostdiv = c.downhillcostdiv;
        self.uphillcostdiv = c.uphillcostdiv;
        let (cfup, cf, cfdown) = (c.cfup, c.cf, c.cfdown);
        let (uphillcutoff, downhillcutoff) = (c.uphillcutoff, c.downhillcutoff);
        let (uphillmaxslope, downhillmaxslope) = (c.uphillmaxslope, c.downhillmaxslope);
        let (uphillmaxslopecostdiv, downhillmaxslopecostdiv) = (c.uphillmaxslopecostdiv, c.downhillmaxslopecostdiv);

        let dist = s.distance as i32; // legacy arithmetics needs int

        // penalty for turning angle
        let mut turncost = ((1.0 - s.cosangle) * f64::from(c.turncostbase) + 0.2) as i32; // e.g. turncost=90 -> 90 degree = 90m penalty

        let new_prio = self.priorityclassifier;
        let old_prio = s.lastpriorityclassifier;

        if rc.bike_mode && rc.consider_crossing && old_prio > 0 && s.nsection == 0 {
            // a LEFT turn from "primary|secondary" onto a lower priority highway at a node with an
            // estimated_crossing_class gets a penalty; for left-hand traffic a RIGHT turn does
            let costs = if s.angle < 0.0 {
                Some(&rc.cost_to_left_from_h)
            } else if s.angle > 0.0 {
                Some(&rc.cost_to_right_from_h)
            } else {
                None
            };
            if let Some(costs) = costs
                && old_prio >= rc.crossing_prio_h
                && new_prio <= rc.crossing_prio_l
                && let Some(description) = source_description
            {
                let node_access_granted = way.node_access_granted() != 0.0;
                let node_tags = node.key_value_description(node_access_granted, description);
                if let Some(class_index) = node_tags.find("estimated_crossing_class=") {
                    let crossing_class = &node_tags.as_bytes()[class_index + 25..class_index + 26];
                    if let Some(class @ 1..=6) = (crossing_class[0] as char).to_digit(10) {
                        turncost = turncost.wrapping_add(costs[class as usize - 1]);
                    }
                }
            }
        }

        if let Some(m) = &mut self.message {
            m.linkturncost = m.linkturncost.wrapping_add(turncost);
        }

        let mut section_cost = f64::from(turncost);

        // *** penalty for elevation
        // only the part of the descend that does not fit into the elevation-hysteresis-buffers
        // leads to an immediate penalty

        let delta_h_micros = (1_000_000.0 * s.delta_h) as i32;
        // int += float: float arithmetic, then a cast
        self.ehbd = (self.ehbd as f32 + ((delta_h_micros.wrapping_neg()) as f32 - dist as f32 * downhillcutoff)) as i32;
        self.ehbu = (self.ehbu as f32 + (delta_h_micros as f32 - dist as f32 * uphillcutoff)) as i32;

        let mut downweight = 0.0f32;
        if self.ehbd > rc.elevationpenaltybuffer {
            downweight = 1.0;

            let mut excess = self.ehbd.wrapping_sub(rc.elevationpenaltybuffer);
            let mut reduce = dist.wrapping_mul(rc.elevationbufferreduce);
            if reduce > excess {
                downweight = excess as f32 / reduce as f32;
                reduce = excess;
            }
            excess = self.ehbd.wrapping_sub(rc.elevationmaxbuffer);
            if reduce < excess {
                reduce = excess;
            }
            self.ehbd = self.ehbd.wrapping_sub(reduce);
            let mut elevation_cost = 0.0f32;
            if self.downhillcostdiv > 0 {
                elevation_cost += min_f32(reduce as f32, dist as f32 * downhillmaxslope) / self.downhillcostdiv as f32;
            }
            if downhillmaxslopecostdiv > 0 {
                elevation_cost +=
                    max_f32(0.0, reduce as f32 - dist as f32 * downhillmaxslope) / downhillmaxslopecostdiv as f32;
            }
            if elevation_cost > 0.0 {
                section_cost += f64::from(elevation_cost);
                if let Some(m) = &mut self.message {
                    m.linkelevationcost = (m.linkelevationcost as f32 + elevation_cost) as i32;
                }
            }
        } else if self.ehbd < 0 {
            self.ehbd = 0;
        }

        let mut upweight = 0.0f32;
        if self.ehbu > rc.elevationpenaltybuffer {
            upweight = 1.0;

            let mut excess = self.ehbu.wrapping_sub(rc.elevationpenaltybuffer);
            let mut reduce = dist.wrapping_mul(rc.elevationbufferreduce);
            if reduce > excess {
                upweight = excess as f32 / reduce as f32;
                reduce = excess;
            }
            excess = self.ehbu.wrapping_sub(rc.elevationmaxbuffer);
            if reduce < excess {
                reduce = excess;
            }
            self.ehbu = self.ehbu.wrapping_sub(reduce);
            let mut elevation_cost = 0.0f32;
            if self.uphillcostdiv > 0 {
                elevation_cost += min_f32(reduce as f32, dist as f32 * uphillmaxslope) / self.uphillcostdiv as f32;
            }
            if uphillmaxslopecostdiv > 0 {
                elevation_cost +=
                    max_f32(0.0, reduce as f32 - dist as f32 * uphillmaxslope) / uphillmaxslopecostdiv as f32;
            }
            if elevation_cost > 0.0 {
                section_cost += f64::from(elevation_cost);
                if let Some(m) = &mut self.message {
                    m.linkelevationcost = (m.linkelevationcost as f32 + elevation_cost) as i32;
                }
            }
        } else if self.ehbu < 0 {
            self.ehbu = 0;
        }

        // get the effective costfactor (slope dependent)
        let costfactor = cfup * upweight + cf * (1.0 - upweight - downweight) + cfdown * downweight;

        if let Some(m) = &mut self.message {
            m.costfactor = costfactor;
        }

        section_cost += f64::from(dist as f32 * costfactor + 0.5);
        section_cost
    }

    /// `StdPath.processTargetNode`: node costs for the target node.
    fn process_target_node(
        &mut self,
        way: &WayContext,
        node: &mut NodeContext,
        description: Option<&[u8]>,
    ) -> Result<f64, ExpressionError> {
        let Some(description) = description else { return Ok(0.0) };
        let node_access_granted = way.node_access_granted() != 0.0;
        node.evaluate(node_access_granted, description, way)?;
        let initialcost = node.initialcost();
        if f64::from(initialcost) >= 1_000_000.0 {
            return Ok(-1.0);
        }
        if let Some(m) = &mut self.message {
            m.linknodecost = m.linknodecost.wrapping_add(initialcost as i32);
            m.node_key_values = Some(node.key_value_description(node_access_granted, description));
        }
        Ok(f64::from(initialcost))
    }

    pub fn elevation_correction(&self) -> i32 {
        (if self.downhillcostdiv > 0 { self.ehbd / self.downhillcostdiv } else { 0 })
            .wrapping_add(if self.uphillcostdiv > 0 { self.ehbu / self.uphillcostdiv } else { 0 })
    }

    pub fn definitly_worse_than(&self, p: &OsmPath) -> bool {
        let mut c = p.cost;
        if p.downhillcostdiv > 0 {
            let delta = p.ehbd / p.downhillcostdiv
                - if self.downhillcostdiv > 0 { self.ehbd / self.downhillcostdiv } else { 0 };
            if delta > 0 {
                c = c.wrapping_add(delta);
            }
        }
        if p.uphillcostdiv > 0 {
            let delta =
                p.ehbu / p.uphillcostdiv - if self.uphillcostdiv > 0 { self.ehbu / self.uphillcostdiv } else { 0 };
            if delta > 0 {
                c = c.wrapping_add(delta);
            }
        }
        self.cost > c
    }

    fn calc_incline(&mut self, dist: f64) -> f64 {
        let min_delta = 3.0;
        let mut shift = 0.0;
        if f64::from(self.elevation_buffer) > min_delta {
            shift = -min_delta;
        } else if f64::from(self.elevation_buffer) < -min_delta {
            shift = min_delta;
        }
        let decay_factor = libm::exp(-dist / 100.0);
        let new_elevation_buffer = ((f64::from(self.elevation_buffer) + shift) * decay_factor - shift) as f32;
        let incline = f64::from(self.elevation_buffer - new_elevation_buffer) / dist;
        self.elevation_buffer = new_elevation_buffer;
        incline
    }

    /// `StdPath.computeKinematic`: travel time and energy, in the final (detail) pass only.
    fn compute_kinematic(&mut self, rc: &RoutingContext, way: &WayContext, dist: f64, delta_h: f64, detail_mode: bool) {
        if !detail_mode {
            return;
        }

        // compute incline
        self.elevation_buffer = (f64::from(self.elevation_buffer) + delta_h) as f32;
        let incline = self.calc_incline(dist);

        let mut max_speed = rc.max_speed;
        let speed_limit = f64::from(way.maxspeed() / 3.6);
        if speed_limit > 0.0 {
            max_speed = min_f64(max_speed, speed_limit);
        }

        let mut speed = max_speed; // Travel speed
        let f_roll = rc.total_mass * GRAVITY * (rc.default_c_r + incline);
        if rc.foot_mode {
            // Use Tobler's hiking function for walking sections
            speed = rc.max_speed * libm::exp(-3.5 * (incline + 0.05).abs());
        } else if rc.bike_mode {
            speed = solve_cubic(rc.s_c_x, f_roll, rc.biker_power);
            speed = min_f64(speed, max_speed);
        }
        let dt = (dist / speed) as f32;
        self.total_time += dt;
        // Calc energy assuming biking (no good model yet for hiking)
        // (Count only positive, negative would mean breaking to enforce maxspeed)
        let energy = dist * (rc.s_c_x * speed * speed + f_roll);
        if energy > 0.0 {
            self.total_energy = (f64::from(self.total_energy) + energy) as f32;
        }
    }

    pub fn total_energy(&self) -> f32 {
        self.total_energy
    }
}

/// `processWaySection`'s inputs from the way context. Java reads them for every section; they only
/// change with the link, so they are read once per link.
struct WayCosts {
    turncostbase: f32,
    uphillcutoff: f32,
    downhillcutoff: f32,
    uphillmaxslope: f32,
    downhillmaxslope: f32,
    cfup: f32,
    cfdown: f32,
    cf: f32,
    downhillcostdiv: i32,
    downhillmaxslopecostdiv: i32,
    uphillcostdiv: i32,
    uphillmaxslopecostdiv: i32,
}

impl WayCosts {
    fn of(way: &WayContext) -> Self {
        let cf = way.costfactor();
        let cfup = way.uphill_costfactor();
        let cfdown = way.downhill_costfactor();
        // a cost's divisor, or `otherwise` for a cost of 0 or less
        let costdiv = |cost: f32, otherwise: Option<i32>| {
            let div = cost as i32;
            if div > 0 { 1_000_000 / div } else { otherwise.unwrap_or(div) }
        };
        let downhillcostdiv = costdiv(way.downhillcost(), None);
        let uphillcostdiv = costdiv(way.uphillcost(), None);
        Self {
            turncostbase: way.turncost(),
            uphillcutoff: way.uphillcutoff() * 10000.0,
            downhillcutoff: way.downhillcutoff() * 10000.0,
            uphillmaxslope: way.uphillmaxslope() * 10000.0,
            downhillmaxslope: way.downhillmaxslope() * 10000.0,
            cfup: if cfup == 0.0 { cf } else { cfup },
            cfdown: if cfdown == 0.0 { cf } else { cfdown },
            cf,
            downhillcostdiv,
            // if no max slope costs are given, use legacy behavior
            downhillmaxslopecostdiv: costdiv(way.downhillmaxslopecost(), Some(downhillcostdiv)),
            uphillcostdiv,
            uphillmaxslopecostdiv: costdiv(way.uphillmaxslopecost(), Some(uphillcostdiv)),
        }
    }
}

/// The inputs of `processWaySection` besides the contexts.
struct Section {
    distance: f64,
    delta_h: f64,
    angle: f64,
    cosangle: f64,
    nsection: usize,
    lastpriorityclassifier: i32,
}

fn interpolate_ele(e1: i16, e2: i16, fraction: f64) -> i16 {
    if e1 == i16::MIN || e2 == i16::MIN {
        return i16::MIN;
    }
    (f64::from(e1) * (1.0 - fraction) + f64::from(e2) * fraction) as i32 as i16
}

/// Solves a * v^3 + c * v = d with a Newton method to get the speed v for the section.
fn solve_cubic(a: f64, c: f64, d: f64) -> f64 {
    let mut v = 8.0;
    let mut finding_startvalue = true;
    for _ in 0..10 {
        let y = (a * v * v + c) * v - d;
        if y < 0.1 {
            if finding_startvalue {
                v *= 2.0;
                continue;
            }
            break;
        }
        finding_startvalue = false;
        let y_prime = 3.0 * a * v * v + c;
        v -= y / y_prime;
    }
    v
}

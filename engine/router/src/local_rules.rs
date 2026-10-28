//! Port of `LocalRoutingRules` (`experiments/routing/brouter-patch/rules/`): the planner's reviewed
//! local bicycle corrections, loaded once from the prepared rule file and shared by all threads.
//! Passages give a closed link a finite cost, turn exceptions let bicycles take a turn a restriction
//! forbids, and avoidance circles cost like weighted nogos. Java's hash indexes, area tree and cell
//! cache only speed up the lookups: the last matching area wins either way, as here.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use brouter_mapaccess::{OsmPos, Pos, TurnRestriction};
use brouter_util::cheap_ruler;

use crate::java::JavaException;
use crate::param_collector::UrlParams;

/// `VersionMismatchException`, which the server answers with HTTP 400 and its message.
pub const VERSION_MISMATCH: &str = "btools.router.LocalRoutingRules$VersionMismatchException";

pub struct LocalRules {
    revision: String,
    /// The revision as the decimal `richiroute_rules_<i>` parameters the planner sends.
    revision_parts: [String; 4],
    guards: Vec<Guard>,
    /// The guard of each passage by its directed link endpoints; a later record replaces an earlier one.
    segments: HashMap<(Pos, Pos), usize>,
    /// (via, from, to) of each turn exception.
    turns: HashSet<(Pos, Pos, Pos)>,
    /// In file order: a later area wins.
    areas: Vec<Area>,
    /// The areas' envelopes together: most sections lie outside.
    bounds: Envelope,
}

struct Guard {
    required: Vec<String>,
    forbidden: Vec<String>,
    absent: Vec<String>,
    costfactor: f32,
}

struct Area {
    center: Pos,
    radius: f64,
    nogo_weight: f64,
    /// Conservative; the exact circle calculation decides intersections.
    envelope: Envelope,
}

#[derive(Clone, Copy)]
struct Envelope {
    min_lon: i32,
    max_lon: i32,
    min_lat: i32,
    max_lat: i32,
}

/// The avoidance circles of a request with local rules: those around the search's waypoints are left
/// out (`cleanNogoList`), as before the rules engine.
#[derive(Clone)]
pub struct ActiveAreas {
    rules: Arc<LocalRules>,
    excluded: Vec<usize>,
}

impl LocalRules {
    /// `LocalRoutingRules.load`.
    pub fn load(file: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(file)
            .map_err(|e| format!("Cannot load local routing rules: {}: {e}", file.display()))?;
        Self::parse(&text)
    }

    fn parse(text: &str) -> Result<Self, String> {
        let mut lines = text.lines();
        let header: Vec<&str> = lines.next().ok_or("Empty local rule file")?.split('\t').collect();
        let hex = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if header.len() != 3 || header[0] != "richiroute-rules" || header[1] != "1" || !hex(header[2]) {
            return Err("Unsupported local rule file".into());
        }
        let revision = header[2].to_string();
        let revision_parts = std::array::from_fn(|i| {
            u64::from_str_radix(&revision[i * 16..i * 16 + 16], 16).expect("checked hex").to_string()
        });
        let mut rules = Self {
            revision,
            revision_parts,
            guards: Vec::new(),
            segments: HashMap::new(),
            turns: HashSet::new(),
            areas: Vec::new(),
            bounds: Envelope { min_lon: i32::MAX, max_lon: i32::MIN, min_lat: i32::MAX, max_lat: i32::MIN },
        };
        let mut guard_ids = HashMap::new();
        for line in lines.filter(|l| !l.is_empty()) {
            let row: Vec<&str> = line.split('\t').collect();
            let int = |i: usize| row[i].parse::<i32>().map_err(|e| format!("{e}: {}", row[i]));
            let pos = |i: usize| Ok::<_, String>(Pos::new(int(i)?, int(i + 1)?));
            let require = |len: usize| if row.len() == len { Ok(()) } else { Err("Malformed local rule record") };
            match row[0] {
                "guard" => {
                    require(6)?;
                    let guard = Guard::new(row[2], row[3], row[4], row[5])?;
                    if guard_ids.insert(row[1], rules.guards.len()).is_some() {
                        return Err("Duplicate rule guard".into());
                    }
                    rules.guards.push(guard);
                }
                "segment" => {
                    require(6)?;
                    let guard = *guard_ids.get(row[1]).ok_or("Missing rule guard")?;
                    rules.segments.insert((pos(2)?, pos(4)?), guard);
                }
                "turn" => {
                    require(8)?;
                    rules.turns.insert((pos(2)?, pos(4)?, pos(6)?));
                }
                "avoidance" => {
                    require(6)?;
                    let number = |i: usize| row[i].parse::<f64>().map_err(|e| format!("{e}: {}", row[i]));
                    let area = Area::new(pos(2)?, number(4)?, number(5)?)?;
                    rules.bounds = rules.bounds.union(area.envelope);
                    rules.areas.push(area);
                }
                kind => return Err(format!("Unknown local rule record: {kind}")),
            }
        }
        Ok(rules)
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }

    /// The version check of `configure`: a request that names a revision must name this one.
    pub(crate) fn check_revision(&self, key_values: &UrlParams) -> Result<(), JavaException> {
        let param = |i: usize| key_values.get(&format!("richiroute_rules_{i}"));
        if (0..4).any(|i| param(i).is_some()) && (0..4).any(|i| param(i) != Some(&self.revision_parts[i])) {
            return Err(JavaException {
                class: VERSION_MISMATCH,
                message: Some("local routing rules version mismatch".into()),
            });
        }
        Ok(())
    }

    pub(crate) fn has_areas(&self) -> bool {
        !self.areas.is_empty()
    }

    /// `mayAccess`: whether a way closed to bicycles matches a passage's tags anywhere.
    pub fn may_access(&self, tags: &str) -> bool {
        let tags = format!(" {tags} ");
        self.guards.iter().any(|g| g.matches(&tags))
    }

    /// `segment(...).costfactor(9999, tags)`: a passage's cost for the closed directed link, or 9999.
    pub(crate) fn passage_costfactor(&self, from: Pos, to: Pos, tags: impl FnOnce() -> String) -> f32 {
        match self.segments.get(&(from, to)) {
            Some(&guard) if self.guards[guard].matches(&format!(" {} ", tags())) => self.guards[guard].costfactor,
            _ => 9999.0,
        }
    }

    /// `isTurnForbidden` with the restrictions at `via`: a turn exception adds the bicycle exception to
    /// the matching negative restrictions, on copies.
    pub(crate) fn is_turn_forbidden<'a>(
        &self,
        via: Pos,
        restrictions: impl IntoIterator<Item = &'a TurnRestriction>,
        from: Pos,
        to: Pos,
        bike_mode: bool,
        car_mode: bool,
    ) -> bool {
        let (from_lon, from_lat, to_lon, to_lat) = (from.ilon, from.ilat, to.ilon, to.ilat);
        if !self.turns.contains(&(via, from, to)) {
            return TurnRestriction::is_turn_forbidden(
                restrictions,
                from_lon,
                from_lat,
                to_lon,
                to_lat,
                bike_mode,
                car_mode,
            );
        }
        let excepted: Vec<TurnRestriction> = restrictions
            .into_iter()
            .map(|tr| {
                let mut tr = tr.clone();
                if !tr.is_positive
                    && (tr.from_lon, tr.from_lat, tr.to_lon, tr.to_lat) == (from_lon, from_lat, to_lon, to_lat)
                {
                    tr.exceptions |= 1;
                }
                tr
            })
            .collect();
        TurnRestriction::is_turn_forbidden(&excepted, from_lon, from_lat, to_lon, to_lat, bike_mode, car_mode)
    }
}

impl Guard {
    fn new(required: &str, forbidden: &str, absent: &str, costfactor: &str) -> Result<Self, String> {
        // Java's split drops trailing empty tokens
        let tokens = |text: &str, end: &str| -> Vec<String> {
            let mut tokens: Vec<&str> = if text.is_empty() { Vec::new() } else { text.split(';').collect() };
            while tokens.last() == Some(&"") {
                tokens.pop();
            }
            tokens.iter().map(|t| format!(" {t}{end}")).collect()
        };
        let costfactor = costfactor.parse::<f32>().map_err(|e| format!("{e}: {costfactor}"))?;
        if !costfactor.is_finite() || !(1.0..9999.0).contains(&costfactor) {
            return Err("Invalid local passage cost".into());
        }
        Ok(Self {
            required: tokens(required, " "),
            forbidden: tokens(forbidden, " "),
            absent: tokens(absent, "="),
            costfactor,
        })
    }

    /// Over the tags with a space on both ends.
    fn matches(&self, tags: &str) -> bool {
        self.required.iter().all(|t| tags.contains(t.as_str()))
            && !self.forbidden.iter().chain(&self.absent).any(|t| tags.contains(t.as_str()))
    }
}

impl Area {
    fn new(center: Pos, radius: f64, nogo_weight: f64) -> Result<Self, String> {
        if !radius.is_finite() || radius <= 0.0 || radius > 10000.0 || !nogo_weight.is_finite() || nogo_weight <= 0.0 {
            return Err("Invalid local avoidance penalty".into());
        }
        let lat_margin = ((radius + 2.0) / 0.05).ceil() as i32;
        let min_lat = (center.ilat - lat_margin).max(0);
        let max_lat = (center.ilat + lat_margin).min(180_000_000);
        let scale = f64::min(
            cheap_ruler::get_lon_lat_to_meter_scales(min_lat)[0],
            cheap_ruler::get_lon_lat_to_meter_scales(max_lat)[0],
        );
        let lon_margin = f64::min(360_000_000.0, ((radius + 2.0) / scale.max(1e-12) * 2.0).ceil()) as i32;
        let envelope = Envelope {
            min_lon: (center.ilon - lon_margin).max(0),
            max_lon: (center.ilon + lon_margin).min(360_000_000),
            min_lat,
            max_lat,
        };
        Ok(Self { center, radius, nogo_weight, envelope })
    }

    /// `Area.apply`: the nogo cost of the section, if it passes through the circle.
    #[allow(clippy::too_many_arguments)]
    fn cost(&self, lon1: i32, lat1: i32, lon2: i32, lat2: i32, d: f64, sx: f64, sy: f64) -> Option<f64> {
        let c = self.center;
        let dx = f64::from(lon2.wrapping_sub(lon1)) * sx;
        let dy = f64::from(lat2.wrapping_sub(lat1)) * sy;
        let (x1, y1) = (f64::from(lon1.wrapping_sub(c.ilon)) * sx, f64::from(lat1.wrapping_sub(c.ilat)) * sy);
        let (x2, y2) = (f64::from(lon2.wrapping_sub(c.ilon)) * sx, f64::from(lat2.wrapping_sub(c.ilat)) * sy);
        let (r12, r22) = (x1 * x1 + y1 * y1, x2 * x2 + y2 * y2);
        let radius = (if r12 < r22 { y1 * dx - x1 * dy } else { y2 * dx - x2 * dy }).abs() / d;
        if radius >= self.radius {
            return None;
        }
        let (mut s1, mut s2) = (x1 * dx + y1 * dy, x2 * dx + y2 * dy);
        if s1 < 0.0 {
            (s1, s2) = (-s1, -s2);
        }
        if s2 > 0.0 && (if s1 < s2 { r12 } else { r22 }).sqrt() > self.radius {
            return None;
        }
        Some(self.distance_within_radius(lon1, lat1, lon2, lat2, d) * self.nogo_weight)
    }

    /// `OsmNodeNamed.distanceWithinRadius`, with Java's int arithmetic.
    fn distance_within_radius(&self, mut lon1: i32, mut lat1: i32, mut lon2: i32, mut lat2: i32, total: f64) -> f64 {
        let (ilon, ilat) = (self.center.ilon, self.center.ilat);
        let lonlat2m = cheap_ruler::get_lon_lat_to_meter_scales(lat1.wrapping_add(lat2) >> 1);
        let first_within = cheap_ruler::distance(lon1, lat1, ilon, ilat) < self.radius;
        let mut last_within = cheap_ruler::distance(lon2, lat2, ilon, ilat) < self.radius;
        if first_within {
            if last_within {
                return total;
            }
            (lon1, lat1, lon2, lat2) = (lon2, lat2, lon1, lat1);
            last_within = true;
        }
        let initial_to_project =
            (f64::from(lon2.wrapping_sub(lon1).wrapping_mul(ilon.wrapping_sub(lon1))) * lonlat2m[0] * lonlat2m[0]
                + f64::from(lat2.wrapping_sub(lat1).wrapping_mul(ilat.wrapping_sub(lat1))) * lonlat2m[1] * lonlat2m[1])
                / total;
        let initial_to_center = cheap_ruler::distance(ilon, ilat, lon1, lat1);
        let half_within = (self.radius * self.radius
            - (initial_to_center * initial_to_center - initial_to_project * initial_to_project))
            .sqrt();
        if last_within { half_within + (total - initial_to_project) } else { 2.0 * half_within }
    }
}

impl Envelope {
    fn union(self, other: Self) -> Self {
        Self {
            min_lon: self.min_lon.min(other.min_lon),
            max_lon: self.max_lon.max(other.max_lon),
            min_lat: self.min_lat.min(other.min_lat),
            max_lat: self.max_lat.max(other.max_lat),
        }
    }

    fn may_touch(&self, lon1: i32, lat1: i32, lon2: i32, lat2: i32) -> bool {
        !(lon1 < self.min_lon && lon2 < self.min_lon
            || lon1 > self.max_lon && lon2 > self.max_lon
            || lat1 < self.min_lat && lat2 < self.min_lat
            || lat1 > self.max_lat && lat2 > self.max_lat)
    }
}

impl ActiveAreas {
    pub(crate) fn new(rules: Arc<LocalRules>) -> Self {
        Self { rules, excluded: Vec::new() }
    }

    /// `clean(waypoints)`: leaves out the circles a waypoint lies in.
    pub(crate) fn clean(&mut self, waypoints: &[Pos]) {
        self.excluded.clear();
        for (i, area) in self.rules.areas.iter().enumerate() {
            let within = |p: &Pos| {
                area.envelope.may_touch(p.ilon, p.ilat, p.ilon, p.ilat)
                    && f64::from(p.calc_distance(&area.center)) < area.radius
            };
            if waypoints.iter().any(within) {
                self.excluded.push(i);
            }
        }
    }

    /// `restore()`.
    pub(crate) fn restore(&mut self) {
        self.excluded.clear();
    }

    /// `apply`: the nogo cost of the last circle the section passes through, if any.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn cost(&self, lon1: i32, lat1: i32, lon2: i32, lat2: i32, d: f64, sx: f64, sy: f64) -> Option<f64> {
        if !self.rules.bounds.may_touch(lon1, lat1, lon2, lat2) {
            return None;
        }
        self.rules.areas.iter().enumerate().rev().find_map(|(i, area)| {
            (!self.excluded.contains(&i) && area.envelope.may_touch(lon1, lat1, lon2, lat2))
                .then(|| area.cost(lon1, lat1, lon2, lat2, d, sx, sy))
                .flatten()
        })
    }
}

#[cfg(test)]
mod tests {
    //! The checks of `LocalRoutingRulesTest.java` that need no profile, on the planner's records.
    use super::*;
    use crate::param_collector::get_url_params;

    const HEADER: &str = "richiroute-rules\t1\t54ce18e1b7abec17c5cdbbf7c0d01d855aaeced39435464fd1c6d0fb8e2f2b38\n";
    const PLANNER: &str = "guard\tweidweg\tbicycle=dismount;foot=yes;highway=steps;ramp:bicycle=yes;surface=concrete\t\
        access=no;access=private;vehicle=no;vehicle=private\toneway;oneway:bicycle\t15\n\
        segment\tweidweg\t195397866\t137102550\t195397832\t137102537\n\
        segment\tweidweg\t195397832\t137102537\t195397866\t137102550\n\
        turn\tries\t195539841\t137103009\t195539580\t137102991\t195538680\t137103321\n";
    const TAGS: &str = "highway=steps bicycle=dismount foot=yes ramp:bicycle=yes surface=concrete";

    fn rules(body: &str) -> LocalRules {
        LocalRules::parse(&format!("{HEADER}{body}")).expect("valid rules")
    }

    fn passage(rules: &LocalRules, [lon1, lat1, lon2, lat2]: [i32; 4], tags: &str) -> f32 {
        rules.passage_costfactor(Pos::new(lon1, lat1), Pos::new(lon2, lat2), || tags.to_string())
    }

    #[test]
    fn passages_need_their_exact_link_and_tags() {
        let rules = rules(PLANNER);
        let link = [195397866, 137102550, 195397832, 137102537];
        assert_eq!(passage(&rules, link, TAGS), 15.0);
        assert_eq!(passage(&rules, [link[2], link[3], link[0], link[1]], TAGS), 15.0, "reverse passage");
        for i in 0..4 {
            let mut moved = link;
            moved[i] += 1;
            assert_eq!(passage(&rules, moved, TAGS), 9999.0, "changed geometry must not match");
        }
        for tag in TAGS.split(' ') {
            assert_eq!(passage(&rules, link, &TAGS.replace(tag, "")), 9999.0, "missing {tag}");
        }
        for tag in ["access=no", "access=private", "vehicle=no", "vehicle=private", "oneway=yes", "oneway:bicycle=no"] {
            let tags = format!("{TAGS} {tag}");
            assert_eq!(passage(&rules, link, &tags), 9999.0, "forbidden {tag}");
            assert!(!rules.may_access(&tags), "decode guard for {tag}");
        }
        assert!(rules.may_access(TAGS));

        let other = self::rules(
            "guard\tother\thighway=steps;bicycle=dismount;\taccess=private\t\t30\n\
             segment\tother\t196000000\t138000000\t196000001\t138000001\n",
        );
        assert_eq!(passage(&other, [196000000, 138000000, 196000001, 138000001], TAGS), 30.0, "a rule needs only data");
        assert_eq!(passage(&other, [196000001, 138000001, 196000000, 138000000], TAGS), 9999.0, "directed passage");
        assert_eq!(passage(&self::rules(""), link, TAGS), 9999.0, "empty rules");
    }

    #[test]
    fn turn_exceptions_lift_only_the_configured_restriction_for_bicycles() {
        let rules = rules(PLANNER);
        let (via, from, to) =
            (Pos::new(195539841, 137103009), Pos::new(195539580, 137102991), Pos::new(195538680, 137103321));
        let mut no_turn = TurnRestriction::default();
        (no_turn.from_lon, no_turn.from_lat, no_turn.to_lon, no_turn.to_lat) = (from.ilon, from.ilat, to.ilon, to.ilat);
        // car and mixed modes never get here: `configure` leaves the rules off for them
        let forbidden = |via: Pos, restrictions: &[TurnRestriction], bike: bool| {
            rules.is_turn_forbidden(via, restrictions, from, to, bike, !bike)
        };
        assert!(!forbidden(via, &[no_turn.clone()], true), "configured bicycle turn");
        assert!(forbidden(via, &[no_turn.clone()], false), "the exception is for bicycles");
        assert!(forbidden(Pos::new(via.ilon + 1, via.ilat), &[no_turn.clone()], true), "changed junction");
        let mut only = no_turn.clone();
        (only.is_positive, only.to_lon) = (true, to.ilon + 1);
        assert!(forbidden(via, &[no_turn, only], true), "a different only-turn restriction still applies");
    }

    #[test]
    fn requests_naming_another_revision_are_refused() {
        let rules = rules(PLANNER);
        let check = |query: &str| rules.check_revision(&get_url_params(&format!("/brouter?{query}")).expect("query"));
        let parts = "richiroute_rules_0=6110849102116547607&richiroute_rules_1=14253255068463668613\
                     &richiroute_rules_2=6534387517481109071&richiroute_rules_3=15115998978156473144";
        assert!(check(parts).is_ok());
        assert!(check("").is_ok(), "requests without a revision");
        for stale in ["richiroute_rules_0=0", &parts.replace("=6534", "=6535")] {
            assert_eq!(check(stale).expect_err("stale revision").class, VERSION_MISMATCH);
        }
    }

    #[test]
    fn circles_cost_the_distance_within_them_and_the_last_one_wins() {
        let center = Pos::new(195377673, 137098973);
        let rules = Arc::new(rules(&format!(
            "avoidance\ta\t{0}\t{1}\t100\t2\navoidance\tb\t{0}\t{1}\t50\t5\navoidance\tc\t{2}\t{1}\t50\t5\n",
            center.ilon,
            center.ilat,
            center.ilon + 100_000
        )));
        let [sx, sy] = cheap_ruler::get_lon_lat_to_meter_scales(center.ilat);
        let cost = |areas: &ActiveAreas, dlat: f64| {
            let (lon1, lon2, lat) = (
                center.ilon - (200.0 / sx) as i32,
                center.ilon + (200.0 / sx) as i32,
                center.ilat + (dlat / sy) as i32,
            );
            areas.cost(lon1, lat, lon2, lat, f64::from(lon2 - lon1) * sx, sx, sy)
        };
        let mut areas = ActiveAreas::new(rules);
        let through = cost(&areas, 0.0).expect("through the circles");
        assert!((through - 100.0 * 5.0).abs() < 1.0, "the later, smaller circle: {through}");
        let edge = cost(&areas, 80.0).expect("through the first circle only");
        assert!((edge - 2.0 * 60.0 * 2.0).abs() < 1.0, "a chord of 2 × 60 m: {edge}");
        assert_eq!(cost(&areas, 120.0), None, "beside both");
        areas.clean(&[center]);
        assert_eq!(cost(&areas, 0.0), None, "a waypoint in the circles leaves them out");
        areas.restore();
        assert!(cost(&areas, 0.0).is_some());
    }

    #[test]
    fn malformed_rule_files_are_refused() {
        assert!(LocalRules::parse("richiroute-rules\t2\tabc\n").is_err());
        for body in [
            "guard\tg\ta=b\t\t\t0.5\n",
            "guard\tg\ta=b\t\t\t15\nguard\tg\ta=b\t\t\t15\n",
            "segment\tmissing\t1\t2\t3\t4\n",
            "turn\tt\t1\t2\t3\n",
            "avoidance\ta\t1\t2\t20000\t5\n",
            "closure\tc\n",
        ] {
            assert!(LocalRules::parse(&format!("{HEADER}{body}")).is_err(), "{body}");
        }
    }
}

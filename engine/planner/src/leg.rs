//! A routed leg as the planner keeps it (`LegGeometry`, `app/src/domain/route-model.ts`): read from the
//! engine's GeoJSON, with its surfaces grouped for a road bike, and its distance and climbing measures.

use std::fmt::Write;

use brouter_util::jmath;

use crate::json::{Json, push_number, push_string};

/// `[longitude, latitude]`.
pub type Coord = [f64; 2];

/// What matters on a road bike: paved or not (`Surface`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    Paved,
    LikelyPaved,
    Rough,
    Unpaved,
    Unknown,
}

impl Surface {
    fn name(self) -> &'static str {
        match self {
            Surface::Paved => "paved",
            Surface::LikelyPaved => "likelyPaved",
            Surface::Rough => "rough",
            Surface::Unpaved => "unpaved",
            Surface::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Kind {
    pub surface: Surface,
    pub tag: Option<String>,
}

/// A run of steps `from..to` of one kind; `osm` is what OSM says where the rider corrected the way.
/// Two spans are of the same kind (`sameKind`) when kind and `osm` are equal.
#[derive(Clone, Debug, PartialEq)]
pub struct Span {
    pub from: usize,
    pub to: usize,
    pub kind: Kind,
    pub osm: Option<Kind>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Leg {
    pub coordinates: Vec<Coord>,
    pub elevations: Option<Vec<f64>>,
    pub distance: f64,
    pub ascent: Option<f64>,
    pub surfaces: Vec<Span>,
}

const RADIANS: f64 = std::f64::consts::PI / 180.0;

/// `distanceMeters`: the haversine distance.
pub fn distance(from: Coord, to: Coord) -> f64 {
    let lat1 = from[1] * RADIANS;
    let lat2 = to[1] * RADIANS;
    let half_lat = jmath::sin((lat2 - lat1) / 2.0);
    let half_lon = jmath::sin((to[0] - from[0]) * RADIANS / 2.0);
    let a = half_lat * half_lat + jmath::cos(lat1) * jmath::cos(lat2) * (half_lon * half_lon);
    2.0 * 6_371_008.8 * jmath::asin(a.min(1.0).sqrt())
}

/// The metres to each point from the first.
pub fn along(coordinates: &[Coord]) -> Vec<f64> {
    let mut meters = 0.0;
    let mut along = Vec::with_capacity(coordinates.len());
    for (i, &coord) in coordinates.iter().enumerate() {
        meters += i.checked_sub(1).map_or(0.0, |previous| distance(coordinates[previous], coord));
        along.push(meters);
    }
    along
}

/// `pathMeters`.
pub fn path_distance(coordinates: &[Coord]) -> f64 {
    coordinates.windows(2).fold(0.0, |sum, step| sum + distance(step[0], step[1]))
}

/// `bearing`: degrees clockwise from north.
pub fn bearing(from: Coord, to: Coord) -> f64 {
    let d_lon = (to[0] - from[0]) * RADIANS;
    let y = jmath::sin(d_lon) * jmath::cos(to[1] * RADIANS);
    let x = jmath::cos(from[1] * RADIANS) * jmath::sin(to[1] * RADIANS)
        - jmath::sin(from[1] * RADIANS) * jmath::cos(to[1] * RADIANS) * jmath::cos(d_lon);
    (jmath::atan2(y, x) / RADIANS + 360.0) % 360.0
}

/// `routerClimbThreshold`.
pub const CLIMB_THRESHOLD: f64 = 5.0;

/// The last of `cumulativeAscent(elevations, routerClimbThreshold)`.
pub fn ascent(elevations: &[f64]) -> f64 {
    climbs(elevations).fold(0.0, |ascent, climbed| ascent + climbed)
}

/// `cumulativeAscent(elevations, routerClimbThreshold)`: the climbing so far at each point.
fn cumulative_ascent(elevations: &[f64]) -> Vec<f64> {
    let so_far = climbs(elevations).scan(0.0, |ascent, climbed| {
        *ascent += climbed;
        Some(*ascent)
    });
    std::iter::once(0.0).chain(so_far).collect()
}

/// What each point after the first climbs: a rise counts once it climbs past the threshold above the last low, and
/// then in full.
fn climbs(elevations: &[f64]) -> impl Iterator<Item = f64> + '_ {
    let (mut low, mut high) = (elevations.first().copied(), None::<f64>);
    elevations.iter().skip(1).map(move |&elevation| {
        let mut climbed = 0.0;
        if let Some(top) = high {
            if elevation > top {
                climbed = elevation - top;
                high = Some(elevation);
            } else if elevation < top - CLIMB_THRESHOLD {
                high = None;
                low = Some(elevation);
            }
        } else if low.is_none_or(|low| elevation < low) {
            low = Some(elevation);
        } else if low.is_some_and(|low| elevation > low + CLIMB_THRESHOLD) {
            climbed = elevation - low.unwrap_or_default();
            high = Some(elevation);
        }
        climbed
    })
}

/// `gpxSectionMeters`.
const SECTION_METERS: f64 = 5000.0;

impl Leg {
    /// A chosen loop as the planner opens it (`loopSections`), like a GPX track: sections of about 5 km between
    /// shaping points, each with its heights, surfaces and share of the climbing, so the totals stay the loop's.
    pub fn sections(&self) -> Vec<Leg> {
        let distances = along(&self.coordinates);
        let walked = distances[distances.len() - 1];
        let scale = if walked > 0.0 { self.distance / walked } else { 0.0 };
        let climbed = self.elevations.as_deref().map(cumulative_ascent);
        // `sectionCuts`: every 5 km, but not within 2.5 km of the end
        let last = distances.len() - 1;
        let mut cuts = vec![0];
        for i in 1..last {
            if distances[i] - distances[cuts[cuts.len() - 1]] >= SECTION_METERS
                && distances[last] - distances[i] >= SECTION_METERS / 2.0
            {
                cuts.push(i);
            }
        }
        if last > 0 {
            cuts.push(last);
        }
        cuts.windows(2)
            .map(|cut| {
                let (from, to) = (cut[0], cut[1]);
                Leg {
                    coordinates: self.coordinates[from..=to].to_vec(),
                    elevations: self.elevations.as_ref().map(|heights| heights[from..=to].to_vec()),
                    distance: (distances[to] - distances[from]) * scale,
                    ascent: climbed.as_ref().map(|climbed| climbed[to] - climbed[from]),
                    // `clipSpans`
                    surfaces: self
                        .surfaces
                        .iter()
                        .filter(|span| span.to > from && span.from < to)
                        .map(|span| Span {
                            from: span.from.max(from) - from,
                            to: span.to.min(to) - from,
                            ..span.clone()
                        })
                        .collect(),
                }
            })
            .collect()
    }
}

/// The material does not matter on a road bike, only whether it is paved; cobblestones are paved but rough.
fn surface_type(tag: Option<&str>) -> Surface {
    match tag.unwrap_or_default() {
        "asphalt" | "paved" | "concrete" | "concrete:lanes" | "concrete:plates" | "paving_stones" => Surface::Paved,
        "cobblestone" | "sett" | "unhewn_cobblestone" | "wood" => Surface::Rough,
        "unpaved" | "gravel" | "fine_gravel" | "compacted" | "ground" | "dirt" | "earth" | "grass" | "grass_paver"
        | "sand" | "mud" | "clay" | "rock" | "pebblestone" | "woodchips" => Surface::Unpaved,
        _ => Surface::Unknown,
    }
}

const LIKELY_PAVED_WAYS: [&str; 12] = [
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "service",
    "cycleway",
];

/// Without a surface tag the groups know, the way's type: on the planner's loop suggestions (October 2026)
/// tagged ways of these types are 95–100 % paved, tracks of grade 2 to 5 95–99 % unpaved. Paths and
/// tracks without a grade stay unknown. `get` looks a tag up.
fn surface_kind<'a>(get: impl Fn(&str) -> Option<&'a str>) -> Kind {
    let tag = get("surface").filter(|tag| !tag.is_empty());
    let tagged = surface_type(tag);
    let tag = tag.map(str::to_string);
    if tagged != Surface::Unknown {
        return Kind { surface: tagged, tag };
    }
    let (highway, grade) = (get("highway").unwrap_or_default(), get("tracktype").unwrap_or_default());
    let surface = if LIKELY_PAVED_WAYS.contains(&highway) || (highway == "track" && grade == "grade1") {
        Surface::LikelyPaved
    } else if highway == "track" && matches!(grade, "grade2" | "grade3" | "grade4" | "grade5") {
        Surface::Unpaved
    } else {
        Surface::Unknown
    };
    Kind { surface, tag }
}

/// A way's kind from its tags, and where the rider corrected it what OSM says, given as
/// `osm:<key>=<value>` (empty where OSM has none).
fn kind_of(way_tags: &str) -> (Kind, Option<Kind>) {
    // JavaScript's slices: a tag without '=' is its key without the last character and its value whole
    let tags: Vec<(&str, &str)> = way_tags
        .split(' ')
        .filter(|tag| !tag.is_empty())
        .map(|tag| match tag.find('=') {
            Some(i) => (&tag[..i], &tag[i + 1..]),
            None => (&tag[..tag.len() - tag.chars().last().map_or(0, char::len_utf8)], tag),
        })
        .collect();
    // a Map: the last value of a key counts
    let get = |key: &str| tags.iter().rev().find(|(k, _)| *k == key).map(|(_, v)| *v);
    let kind = surface_kind(get);
    let corrected = tags.iter().any(|(key, _)| key.starts_with("osm:"));
    let osm = corrected.then(|| surface_kind(|key: &str| get(&format!("osm:{key}")).or_else(|| get(key))));
    (kind, osm)
}

impl Leg {
    /// The leg of the engine's GeoJSON: its first line, with the surfaces of the way tags in its messages
    /// (spans the messages do not reach stay unknown); a single point is drawn as two.
    pub fn from_geojson(text: &str) -> Result<Leg, String> {
        let raw = Json::parse(text)?;
        let feature = raw.get("features").and_then(Json::array).and_then(|features| {
            features
                .iter()
                .find(|f| f.get("geometry").and_then(|g| g.get("type")) == Some(&Json::String("LineString".into())))
        });
        let geometry = feature.and_then(|f| f.get("geometry"));
        let points = geometry.and_then(|g| g.get("coordinates")).and_then(Json::array).filter(|p| !p.is_empty());
        let points = points.ok_or("no track points")?;
        let mut coordinates = points
            .iter()
            .map(|point| {
                let finite = |i: usize| point.array()?.get(i)?.number().filter(|n| n.is_finite());
                match (finite(0), finite(1)) {
                    (Some(lon), Some(lat)) if lon.abs() <= 180.0 && lat.abs() <= 90.0 => Ok([lon, lat]),
                    _ => Err("invalid track points"),
                }
            })
            .collect::<Result<Vec<Coord>, _>>()?;
        let mut elevations = points
            .iter()
            .map(|point| point.array()?.get(2)?.number().filter(|n| n.is_finite()))
            .collect::<Option<Vec<f64>>>();
        let properties = feature.and_then(|f| f.get("properties"));
        let property = |key: &str| properties.and_then(|p| p.get(key)).filter(|v| **v != Json::Null);
        let distance = property("track-length").map(Json::to_number);
        let distance = distance.filter(|d| d.is_finite() && *d >= 0.0 && (coordinates.len() > 1 || *d == 0.0));
        let distance = distance.ok_or("no valid track length")?;

        let mut surfaces: Vec<Span> = Vec::new();
        let messages = properties.and_then(|p| p.get("messages")).and_then(Json::array);
        if let Some((Some(header), rows)) = messages.and_then(|m| m.split_first()).map(|(h, rows)| (h.array(), rows)) {
            let column = |name: &str| header.iter().position(|h| h.str() == Some(name));
            if let (Some(lon), Some(lat), Some(tags)) = (column("Longitude"), column("Latitude"), column("WayTags")) {
                let distance = column("Distance");
                let mut start = 0;
                for row in rows {
                    let Some(row) = row.array() else { break };
                    let cell = |i: usize| row.get(i).map_or(f64::NAN, Json::to_number);
                    let mut end = start + usize::from(distance.is_some_and(|d| cell(d) > 0.0));
                    while end < coordinates.len()
                        && !(jmath::round(coordinates[end][0] * 1e6) as f64 == cell(lon)
                            && jmath::round(coordinates[end][1] * 1e6) as f64 == cell(lat))
                    {
                        end += 1;
                    }
                    if end == coordinates.len() {
                        break; // unmatched spans remain unknown
                    }
                    if end > start {
                        let (kind, osm) = kind_of(row.get(tags).and_then(Json::str).unwrap_or_default());
                        match surfaces.last_mut() {
                            Some(previous) if previous.to == start && previous.kind == kind && previous.osm == osm => {
                                previous.to = end;
                            }
                            _ => surfaces.push(Span { from: start, to: end, kind, osm }),
                        }
                    }
                    start = end;
                }
            }
        }
        if coordinates.len() == 1 {
            coordinates.push(coordinates[0]);
            if let Some(elevations) = &mut elevations {
                elevations.push(elevations[0]);
            }
        }
        // BRouter's filtered ascent runs about a tenth low, so its heights are filtered like file heights, only coarser
        let ascent = match &elevations {
            Some(elevations) => Some(ascent(elevations)),
            None => property("filtered ascend").map(Json::to_number).filter(|a| a.is_finite()),
        };
        Ok(Leg { coordinates, elevations, distance, ascent, surfaces })
    }

    /// The leg as JSON, as the planner keeps it (`LegGeometry`).
    pub fn push_json(&self, out: &mut String) {
        out.push_str("{\"coordinates\":");
        push_coords(out, &self.coordinates);
        out.push_str(",\"elevations\":");
        match &self.elevations {
            Some(elevations) => push_numbers(out, elevations),
            None => out.push_str("null"),
        }
        out.push_str(",\"distanceMeters\":");
        push_number(out, self.distance);
        out.push_str(",\"ascentMeters\":");
        push_number(out, self.ascent.unwrap_or(f64::NAN));
        out.push_str(",\"surfaces\":[");
        for (i, span) in self.surfaces.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            let _ = write!(out, "{{\"fromIndex\":{},\"toIndex\":{},", span.from, span.to);
            push_kind(out, &span.kind);
            if let Some(osm) = &span.osm {
                out.push_str(",\"osm\":{");
                push_kind(out, osm);
                out.push('}');
            }
            out.push('}');
        }
        out.push_str("]}");
    }
}

fn push_kind(out: &mut String, kind: &Kind) {
    out.push_str("\"surface\":");
    push_string(out, kind.surface.name());
    if let Some(tag) = &kind.tag {
        out.push_str(",\"surfaceTag\":");
        push_string(out, tag);
    }
}

fn push_numbers(out: &mut String, numbers: &[f64]) {
    out.push('[');
    for (i, &n) in numbers.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_number(out, n);
    }
    out.push(']');
}

pub fn push_coords(out: &mut String, coordinates: &[Coord]) {
    out.push('[');
    for (i, coord) in coordinates.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_numbers(out, coord);
    }
    out.push(']');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_engines_geojson_as_the_planner_does() {
        let geojson = r#"{"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {
            "track-length": "250", "filtered ascend": "3", "messages": [
              ["Longitude", "Latitude", "Elevation", "Distance", "WayTags"],
              ["15001000", "47000000", "300", "100", "highway=residential surface=asphalt"],
              ["15002000", "47000000", "310", "100", "highway=residential surface=asphalt"],
              ["15003000", "47000000", "312", "50", "highway=track tracktype=grade3 osm:surface=asphalt"]]},
            "geometry": {"type": "LineString", "coordinates": [
              [15.0, 47.0, 300], [15.001, 47.0, 300], [15.002, 47.0, 310], [15.0025, 47.0, 311], [15.003, 47.0, 312]]}}]}"#;
        let leg = Leg::from_geojson(geojson).unwrap();
        assert_eq!(leg.distance, 250.0);
        assert_eq!(leg.ascent, Some(12.0), "heights, not BRouter's filtered ascent");
        let asphalt = Kind { surface: Surface::Paved, tag: Some("asphalt".into()) };
        assert_eq!(
            leg.surfaces,
            [
                Span { from: 0, to: 2, kind: asphalt.clone(), osm: None },
                Span { from: 2, to: 4, kind: Kind { surface: Surface::Unpaved, tag: None }, osm: Some(asphalt) },
            ]
        );
        let mut json = String::new();
        leg.push_json(&mut json);
        assert!(json.starts_with(r#"{"coordinates":[[15,47],[15.001,47],"#), "{json}");
        assert!(json.ends_with(
            r#""distanceMeters":250,"ascentMeters":12,"surfaces":[{"fromIndex":0,"toIndex":2,"surface":"paved","surfaceTag":"asphalt"},{"fromIndex":2,"toIndex":4,"surface":"unpaved","osm":{"surface":"paved","surfaceTag":"asphalt"}}]}"#
        ), "{json}");

        let single = r#"{"features": [{"geometry": {"type": "LineString", "coordinates": [[15, 47]]},
            "properties": {"track-length": "0", "filtered ascend": "7"}}]}"#;
        let leg = Leg::from_geojson(single).unwrap();
        assert_eq!((leg.coordinates.len(), leg.elevations, leg.ascent), (2, None, Some(7.0)));
        assert!(Leg::from_geojson(r#"{"features": []}"#).is_err());
        assert!(Leg::from_geojson(&single.replace("\"0\"", "\"-1\"")).is_err());
    }

    /// A leg through 15.000, 15.001, … °E at 47 °N with message `rows` of a point's longitude (in
    /// millionths) and way tags, and a Distance column where `distance`.
    fn leg_along(points: usize, rows: &[(&str, &str)], distance: bool) -> Leg {
        let coordinates: Vec<_> = (0..points).map(|i| format!("[{}, 47]", 15.0 + i as f64 / 1000.0)).collect();
        let header = if distance {
            r#"["Longitude", "Latitude", "Distance", "WayTags"]"#
        } else {
            r#"["Longitude", "Latitude", "WayTags"]"#
        };
        let rows: Vec<_> = rows
            .iter()
            .map(|(lon, tags)| {
                format!(r#"["{lon}", "47000000", {}"{tags}"]"#, if distance { r#""100", "# } else { "" })
            })
            .collect();
        Leg::from_geojson(&format!(
            r#"{{"features": [{{"geometry": {{"type": "LineString", "coordinates": [{}]}},
                "properties": {{"track-length": "100", "messages": [{header}, {}]}}}}]}}"#,
            coordinates.join(", "),
            rows.join(", ")
        ))
        .unwrap()
    }

    fn spans(leg: &Leg) -> Vec<(usize, usize, Surface, Option<&str>)> {
        leg.surfaces.iter().map(|s| (s.from, s.to, s.kind.surface, s.kind.tag.as_deref())).collect()
    }

    #[test]
    fn message_ends_delimit_spans_and_unmatched_tails_stay_unknown() {
        let rows = [
            ("15001000", "highway=cycleway surface=asphalt"),
            ("15002000", "highway=path"),
            ("16000000", "surface=asphalt"),
        ];
        let leg = leg_along(4, &rows, false);
        assert_eq!(spans(&leg), [(0, 1, Surface::Paved, Some("asphalt")), (1, 2, Surface::Unknown, None)]);
        // a span returning to where it started covers the loop
        let geojson = r#"{"features": [{"geometry": {"type": "LineString", "coordinates": [[15, 47], [15.001, 47.001], [15, 47]]},
            "properties": {"track-length": "100", "messages": [["Longitude", "Latitude", "Distance", "WayTags"],
            ["15000000", "47000000", "100", "surface=asphalt"]]}}]}"#;
        assert_eq!(spans(&Leg::from_geojson(geojson).unwrap()), [(0, 2, Surface::Paved, Some("asphalt"))]);
        for bad in [r#"[[190, 47], [15, 47]]"#, r#"[[15, 47]]"#] {
            let geojson = format!(
                r#"{{"features": [{{"geometry": {{"type": "LineString", "coordinates": {bad}}},
                "properties": {{"track-length": "100"}}}}]}}"#
            );
            assert!(Leg::from_geojson(&geojson).is_err(), "{bad}");
        }
        let no_length = r#"{"features": [{"geometry": {"type": "LineString", "coordinates": [[15, 47], [15.1, 47]]},
            "properties": {"track-length": null}}]}"#;
        assert!(Leg::from_geojson(no_length).is_err());
    }

    #[test]
    fn materials_are_grouped_by_what_they_mean_on_a_road_bike() {
        for tag in ["asphalt", "concrete", "concrete:plates", "paved", "paving_stones"] {
            assert_eq!(surface_type(Some(tag)), Surface::Paved, "{tag}");
        }
        for tag in ["wood", "sett", "cobblestone", "unhewn_cobblestone"] {
            assert_eq!(surface_type(Some(tag)), Surface::Rough, "{tag}");
        }
        for tag in ["gravel", "fine_gravel", "pebblestone", "compacted", "ground", "grass_paver"] {
            assert_eq!(surface_type(Some(tag)), Surface::Unpaved, "{tag}");
        }
        assert_eq!(surface_type(Some("metal")), Surface::Unknown);
        assert_eq!(surface_type(None), Surface::Unknown);
    }

    #[test]
    fn spans_keep_their_materials_within_a_group_and_untagged_ways_count_by_type() {
        let rows = [
            ("15001000", "surface=paving_stones"),
            ("15002000", "surface=wood"),
            ("15003000", "surface=metal"),
            ("15004000", "highway=residential"),
            ("15005000", "highway=secondary"),
            ("15006000", "highway=track tracktype=grade1"),
            ("15007000", "highway=track tracktype=grade3"),
            ("15008000", "highway=primary surface=gravel"),
            ("15009000", "highway=primary surface=unknown"),
        ];
        assert_eq!(
            spans(&leg_along(10, &rows, true)),
            [
                (0, 1, Surface::Paved, Some("paving_stones")),
                (1, 2, Surface::Rough, Some("wood")),
                (2, 3, Surface::Unknown, Some("metal")),
                (3, 6, Surface::LikelyPaved, None),
                (6, 7, Surface::Unpaved, None),
                (7, 8, Surface::Unpaved, Some("gravel")),
                (8, 9, Surface::LikelyPaved, Some("unknown")),
            ]
        );
    }

    #[test]
    fn a_corrected_stretch_keeps_what_osm_says_about_it() {
        let rows = [
            ("15001000", "highway=track tracktype=grade1 surface=unpaved osm:surface= osm:tracktype=grade1"),
            ("15002000", "highway=track tracktype=grade1 surface=paved osm:surface=gravel"),
            ("15003000", "highway=track tracktype=grade1 surface=paved osm:surface=gravel"),
        ];
        let leg = leg_along(4, &rows, false);
        let osm: Vec<_> = leg.surfaces.iter().map(|s| (s.from, s.to, s.osm.clone())).collect();
        assert_eq!(
            osm,
            [
                (0, 1, Some(Kind { surface: Surface::LikelyPaved, tag: None })),
                (1, 3, Some(Kind { surface: Surface::Unpaved, tag: Some("gravel".into()) })),
            ]
        );
        assert_eq!(spans(&leg)[1], (1, 3, Surface::Paved, Some("paved")));
    }

    #[test]
    fn kinds_without_a_surface_tag_come_from_the_way() {
        assert_eq!(kind_of("highway=tertiary").0.surface, Surface::LikelyPaved);
        assert_eq!(kind_of("highway=track tracktype=grade1").0.surface, Surface::LikelyPaved);
        assert_eq!(kind_of("highway=path").0.surface, Surface::Unknown);
        assert_eq!(kind_of("highway=path surface=").0, Kind { surface: Surface::Unknown, tag: None });
        assert_eq!(kind_of("surface=sett").0, Kind { surface: Surface::Rough, tag: Some("sett".into()) });
        assert_eq!(kind_of("surface=foo highway=track").0, Kind { surface: Surface::Unknown, tag: Some("foo".into()) });
        assert_eq!(
            kind_of("surfaces").0,
            Kind { surface: Surface::Unknown, tag: Some("surfaces".into()) },
            "JavaScript's slices"
        );
    }

    #[test]
    fn climbing_counts_past_the_threshold() {
        assert_eq!(ascent(&[300.0, 303.0, 301.0, 307.0, 310.0, 304.0, 309.0]), 10.0);
        assert_eq!(ascent(&[]), 0.0);
    }

    #[test]
    fn a_loop_opens_in_sections_of_about_five_kilometres() {
        // 12 km due north in 120 steps of about 100 m, climbing 1 m a step, paved for the first half
        let coordinates: Vec<Coord> = (0..=120).map(|i| [15.0, 47.0 + f64::from(i) * 0.0009]).collect();
        let kind = Kind { surface: Surface::Paved, tag: Some("asphalt".into()) };
        let leg = Leg {
            elevations: Some((0..=120).map(f64::from).collect()),
            distance: path_distance(&coordinates) * 1.01,
            ascent: Some(120.0),
            surfaces: vec![Span { from: 0, to: 62, kind, osm: None }],
            coordinates,
        };
        let sections = leg.sections();
        assert_eq!(
            sections.iter().map(|s| s.coordinates.len() - 1).collect::<Vec<_>>(),
            [50, 70],
            "no cut within 2.5 km of the end"
        );
        assert_eq!(sections[0].coordinates[50], sections[1].coordinates[0]);
        assert!((sections.iter().map(|s| s.distance).sum::<f64>() - leg.distance).abs() < 1e-6, "scaled to the leg's");
        assert_eq!(sections.iter().map(|s| s.ascent.unwrap()).sum::<f64>(), 120.0);
        assert_eq!((sections[0].surfaces[0].from, sections[0].surfaces[0].to), (0, 50));
        assert_eq!((sections[1].surfaces[0].from, sections[1].surfaces[0].to), (0, 12));
    }
}

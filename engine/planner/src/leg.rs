//! A routed leg as the planner sees it (`LegGeometry`, `app/src/domain/route-model.ts`): read from the
//! engine's GeoJSON as `parseBRouterLeg` (`route-response.ts`) reads it, with its distance and climbing
//! measures.

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
    let (mut low, mut high, mut ascent) = (elevations.first().copied(), None::<f64>, 0.0);
    for &elevation in elevations.iter().skip(1) {
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
        ascent += climbed;
    }
    ascent
}

/// `surfaceType`.
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

/// `surfaceKind`, with `get` looking a tag up.
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

/// `kindOf`: a way's kind from its tags, and where the rider corrected it what OSM says, given as
/// `osm:<key>=<value>`.
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
    /// `parseBRouterLeg` on the engine's GeoJSON.
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
}

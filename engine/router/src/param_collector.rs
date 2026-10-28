//! Port of `RoutingParamCollector` and `OsmNodeNamed` (as far as waypoints need it): reading the
//! request's query string into waypoints and routing settings.

use brouter_mapaccess::MatchedWaypoint;

use crate::java::{self, JavaException, hash_map_order};
use crate::routing_context::RoutingContext;

/// Port of `OsmNodeNamed` as a waypoint: a position with a name and a waypoint type (the radius and
/// nogo fields belong to nogos, which are not supported).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OsmNodeNamed {
    pub ilon: i32,
    pub ilat: i32,
    pub name: String,
    pub wpttype: i8,
}

impl OsmNodeNamed {
    pub fn new(ilon: i32, ilat: i32, name: impl Into<String>) -> Self {
        Self { ilon, ilat, name: name.into(), wpttype: MatchedWaypoint::WAYPOINT_TYPE_SHAPING }
    }
}

/// A Java `HashMap<String, String>` (the request parameters, the profile's key values): it keeps
/// insertion order and removed keys, so that `entries` can list them in `HashMap` iteration order.
#[derive(Clone, Debug, Default)]
pub struct UrlParams {
    entries: Vec<(String, Option<String>)>,
}

impl UrlParams {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries.iter().find(|(k, _)| k == key).and_then(|(_, v)| v.as_deref())
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn put(&mut self, key: &str, value: &str) {
        match self.entries.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = Some(value.to_string()),
            None => self.entries.push((key.to_string(), Some(value.to_string()))),
        }
    }

    /// Removing keeps the key's place: a Java `HashMap` does not shrink.
    pub fn remove(&mut self, key: &str) {
        if let Some(entry) = self.entries.iter_mut().find(|(k, _)| k == key) {
            entry.1 = None;
        }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.iter().all(|(_, v)| v.is_none())
    }

    /// The entries in Java's iteration order.
    pub fn entries(&self) -> Vec<(&str, &str)> {
        hash_map_order(&self.entries.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>())
            .into_iter()
            .filter_map(|i| {
                let (k, v) = &self.entries[i];
                v.as_deref().map(|v| (k.as_str(), v))
            })
            .collect()
    }
}

/// `getUrlParams`: decodes the whole URL, then splits it at `?` and `&` and each part at `=`
/// (`StringTokenizer`: empty tokens vanish, a third token is ignored, a key without value is skipped).
pub fn get_url_params(url: &str) -> Result<UrlParams, JavaException> {
    let decoded = java::url_decode(url)?;
    let mut params = UrlParams::default();
    for t in decoded.split(['?', '&']).filter(|t| !t.is_empty()) {
        let mut tk2 = t.split('=').filter(|t| !t.is_empty());
        if let (Some(key), Some(value)) = (tk2.next(), tk2.next()) {
            params.put(key, value);
        }
    }
    Ok(params)
}

/// `getWayPointList`: `lon,lat[,type or name]` points separated by `;` or `|`.
pub fn get_way_point_list(lon_lats: Option<&str>) -> Result<Vec<OsmNodeNamed>, JavaException> {
    let lon_lats = lon_lats.ok_or_else(|| JavaException::illegal_argument("lonlats parameter not set"))?;
    let coords = java::split(lon_lats, |c| c == ';' || c == '|'); // use both variantes
    if coords.first().is_none_or(|c| !c.contains(',')) {
        return Err(JavaException::illegal_argument("we need one lat/lon point at least!"));
    }

    let mut wplist = Vec::with_capacity(coords.len());
    for (i, coord) in coords.iter().enumerate() {
        let lon_lat = java::split(coord, |c| c == ',');
        if lon_lat.is_empty() {
            return Err(JavaException::illegal_argument("we need one lat/lon point at least!"));
        }
        let lat = lon_lat.get(1).ok_or_else(|| {
            JavaException::new(
                "java.lang.ArrayIndexOutOfBoundsException",
                format!("Index 1 out of bounds for length {}", lon_lat.len()),
            )
        })?;
        let lon = java::parse_double(lon_lat[0])?;
        let lat = java::parse_double(lat)?;
        let mut n = OsmNodeNamed::new(
            ((lon + 180.0) * 1_000_000.0 + 0.5) as i32,
            ((lat + 90.0) * 1_000_000.0 + 0.5) as i32,
            format!("via{i}"),
        );
        if let Some(&kind) = lon_lat.get(2) {
            match kind {
                "d" => n.wpttype = MatchedWaypoint::WAYPOINT_TYPE_DIRECT,
                "m" => n.wpttype = MatchedWaypoint::WAYPOINT_TYPE_MEETING,
                name => {
                    n.name = name.to_string();
                    n.wpttype = MatchedWaypoint::WAYPOINT_TYPE_MEETING;
                }
            }
        }
        wplist.push(n);
    }

    if wplist[0].name.starts_with("via") {
        wplist[0].name = "from".to_string();
    }
    let last = wplist.len() - 1;
    if wplist[last].name.starts_with("via") {
        wplist[last].name = "to".to_string();
    }
    Ok(wplist)
}

/// Whether Java would read any nogo from the parameters (`readNogos`, `readNogoList`,
/// `parseNogoPolygons`; malformed ones make Java throw instead).
fn creates_nogos(params: &UrlParams) -> bool {
    let count = |key: &str, separator: char| params.get(key).map_or(0, |v| java::split(v, |c| c == separator).len());
    let polygons = |key: &str| {
        params
            .get(key)
            .is_some_and(|v| java::split(v, |c| c == '|').iter().any(|p| java::split(p, |c| c == ',').len() > 1))
    };
    count("nogoLats", ',').min(count("nogoLons", ',')).min(count("nogoRadi", ',')) > 0
        || count("nogos", '|') > 0
        || polygons("polylines")
        || polygons("polygons")
}

/// `setParams`: fills the request parameters into the routing context, in `HashMap` order (which
/// decides when two keys set the same field, e.g. `heading` and `direction`).
pub fn set_params(
    rctx: &mut RoutingContext,
    wplist: &mut [OsmNodeNamed],
    params: &mut UrlParams,
) -> Result<(), JavaException> {
    if params.is_empty() {
        return Ok(());
    }
    if let Some(profile) = params.get("profile") {
        rctx.local_function = Some(profile.to_string());
    }
    if creates_nogos(params) {
        rctx.unsupported = Some("nogos".to_string());
    }
    for key in ["nogoLats", "nogoLons", "nogoRadi", "nogos", "polylines", "polygons"] {
        params.remove(key);
    }

    for (key, value) in params.entries() {
        match key {
            "straight" => {
                // Java stops at the first bad number or negative index and only prints the exception
                for v in java::split(value, |c| c == ',').into_iter().map(java::parse_int) {
                    let Ok(Ok(v)) = v.map(usize::try_from) else { break };
                    if let Some(wp) = wplist.get_mut(v) {
                        wp.wpttype = MatchedWaypoint::WAYPOINT_TYPE_DIRECT;
                    }
                }
            }
            "pois" => {
                // readPoisList keeps the lon,lat,name entries
                if java::split(value, |c| c == '|').iter().any(|poi| java::split(poi, |c| c == ',').len() == 3) {
                    rctx.unsupported = Some("pois".to_string());
                }
            }
            "heading" => {
                rctx.start_direction = Some(java::parse_int(value)?);
                rctx.force_use_start_direction = true;
            }
            "direction" => rctx.start_direction = Some(java::parse_int(value)?),
            "roundTripDistance" => rctx.round_trip_distance = Some(java::parse_int(value)?),
            "roundTripDirectionAdd" => {
                java::parse_int(value)?; // read but never used
            }
            "roundTripPoints" => {
                let points = java::parse_int(value)?;
                rctx.round_trip_points = Some(if (3..=20).contains(&points) { points } else { 5 });
            }
            "allowSamewayback" => rctx.allow_samewayback = java::parse_int(value)? == 1,
            "alternativeidx" => rctx.alternative_idx = java::parse_int(value)?,
            "turnInstructionMode" | "timode" => rctx.turn_instruction_mode = java::parse_int(value)?,
            "turnInstructionFormat" => {
                if value.eq_ignore_ascii_case("osmand") {
                    rctx.turn_instruction_mode = 3;
                } else if value.eq_ignore_ascii_case("locus") {
                    rctx.turn_instruction_mode = 2;
                }
            }
            "exportWaypoints" | "exportCorrectedWaypoints" => {
                // only take effect when writing track files
                java::parse_int(value)?;
            }
            _ => {
                if let Some(name) = key.strip_prefix("profile:") {
                    rctx.key_values.put(name, value);
                }
                // "format" and "trackFormat" select the output format, which the caller decides; other
                // parameters are ignored
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_planner_query() {
        let query = "/brouter?profile=richi-local-v1&lonlats=15.4395%2C47.0707%7C15.45%2C47.08%2Chome%7C15.5%2C47.1%2Cd\
                     &format=geojson&alternativeidx=0&heading=90&direction=45&x==&=y&profile%3Apass1coefficient=2";
        let mut params = get_url_params(query).unwrap();
        assert_eq!(params.get("lonlats"), Some("15.4395,47.0707|15.45,47.08,home|15.5,47.1,d"));
        assert_eq!(params.get("x"), None);
        let mut wps = get_way_point_list(params.get("lonlats")).unwrap();
        assert_eq!(wps[0], OsmNodeNamed::new(195_439_500, 137_070_700, "from"));
        assert_eq!((wps[1].name.as_str(), wps[1].wpttype), ("home", MatchedWaypoint::WAYPOINT_TYPE_MEETING));
        assert_eq!((wps[2].name.as_str(), wps[2].wpttype), ("to", MatchedWaypoint::WAYPOINT_TYPE_DIRECT));

        let mut rc = RoutingContext::new();
        params.remove("profile");
        set_params(&mut rc, &mut wps, &mut params).unwrap();
        // HashMap order puts "heading" before "direction": the direction wins, the heading stays forced
        assert_eq!((rc.start_direction, rc.force_use_start_direction), (Some(45), true));
        assert_eq!(rc.key_values.entries(), [("pass1coefficient", "2")]);
        assert_eq!(rc.local_function, None);
    }

    #[test]
    fn way_point_errors() {
        let message = |s: &str| get_way_point_list(Some(s)).unwrap_err().to_string();
        assert_eq!(message("15.4"), "java.lang.IllegalArgumentException: we need one lat/lon point at least!");
        assert_eq!(message("15.4,"), "java.lang.ArrayIndexOutOfBoundsException: Index 1 out of bounds for length 1");
        assert_eq!(message("x,1"), "java.lang.NumberFormatException: For input string: \"x\"");
        assert!(get_way_point_list(None).is_err());
    }
}

//! Places as the planner finds and names them (`app/src/services/geocoding.service.ts`): the suggestions for a search
//! (`forwardGeocode`) and the name of a point set on the map (`reverseGeocode`), from the address search's answers
//! (Photon's GeoJSON).

use std::collections::HashSet;
use std::fmt::Write;

use crate::json::{Json, push_number, push_string};
use crate::leg::{Coord, distance};

/// What a place is, as its suggestion shows it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Category {
    Address,
    Street,
    Town,
    Mountain,
    Station,
    Water,
    Place,
}

impl Category {
    fn name(self) -> &'static str {
        match self {
            Category::Address => "address",
            Category::Street => "street",
            Category::Town => "town",
            Category::Mountain => "mountain",
            Category::Station => "station",
            Category::Water => "water",
            Category::Place => "place",
        }
    }
}

/// A suggestion: the full name a stop takes (`label`), shown as what (`title`) and where (`detail`).
#[derive(Debug, PartialEq)]
pub struct Place {
    pub label: String,
    pub title: String,
    pub detail: Option<String>,
    pub category: Category,
    pub coord: Coord,
    /// The street of an address (a house, a shop), whose own position lies off the street.
    pub street: Option<String>,
    town: Option<String>,
}

/// How many features the planner asks the search for, and how many suggestions it shows.
pub const SEARCH_LIMIT: usize = 20;
const SUGGESTIONS: usize = 8;

/// The suggestions from the answers of each area's search to `/api/`, best first: those of all areas, a place found by
/// an earlier area left out, without clutter, one per address and one per name in a town.
pub fn places(answers: &[String]) -> Vec<Place> {
    let parsed: Vec<Json> = answers.iter().filter_map(|answer| Json::parse(answer).ok()).collect();
    // a place an earlier area found already: areas overlap at their borders
    let key = |feature: &Json| {
        let name = feature.get("properties").and_then(|p| p.get("name")).and_then(Json::str).map(str::to_string);
        (name, feature.get("geometry").and_then(|g| g.get("coordinates")).map(|c| format!("{c:?}")))
    };
    let mut earlier = HashSet::new();
    let features: Vec<&Json> = parsed
        .iter()
        .filter_map(|answer| answer.get("features")?.array())
        .flat_map(|features| {
            let fresh: Vec<&Json> = features.iter().filter(|feature| !earlier.contains(&key(feature))).collect();
            earlier.extend(features.iter().map(key));
            fresh
        })
        .take(SEARCH_LIMIT)
        .filter(|feature| !feature.get("properties").is_some_and(is_clutter))
        .collect();
    let named = |feature: &Json| {
        feature.get("properties").and_then(|p| p.get("name")).and_then(Json::str).is_some_and(|n| !n.is_empty())
    };
    // one entry per address: the shops and offices at a house give way to the address itself
    let address = |feature: &Json| {
        let p = feature.get("properties")?;
        let raw = |key: &str| p.get(key).and_then(Json::str).unwrap_or_default().to_string();
        (!raw("housenumber").is_empty()).then(|| (raw("street"), raw("housenumber"), raw("city")))
    };
    let unnamed: HashSet<_> = features.iter().filter(|f| !named(f)).map(|f| address(f)).collect();
    let mut kept: Vec<Place> = Vec::new();
    for (i, feature) in features.iter().enumerate() {
        let keep = match address(feature) {
            None => true,
            Some(at) if unnamed.contains(&Some(at.clone())) => !named(feature),
            Some(at) => features.iter().position(|other| address(other).as_ref() == Some(&at)) == Some(i),
        };
        let Some(place) = keep.then(|| parse_place(feature)).flatten() else { continue };
        // one name in one town is one place, the first and best match; without a town, only a repeat nearby
        let key = merge_key(&place.label);
        let repeated = kept.iter().any(|other| {
            merge_key(&other.label) == key && (place.town.is_some() || distance(other.coord, place.coord) < 200.0)
        });
        if !repeated {
            kept.push(place);
        }
    }
    kept.truncate(SUGGESTIONS);
    kept
}

/// The nearest point on `lines` within `max_meters` of `at`, in local metres around it (`nearestOnLines`,
/// `app/src/services/street-point.service.ts`), with its distance: where an address meets its own street.
pub fn nearest_on_lines(at: Coord, lines: &[Vec<Coord>], max_meters: f64) -> Option<(Coord, f64)> {
    let [lon, lat] = at;
    let (x, y) = (111_320.0 * (lat * std::f64::consts::PI / 180.0).cos(), 110_540.0);
    let mut best = None;
    let mut best_meters = max_meters;
    for line in lines {
        for piece in line.windows(2) {
            let (ax, ay) = ((piece[0][0] - lon) * x, (piece[0][1] - lat) * y);
            let (bx, by) = ((piece[1][0] - lon) * x, (piece[1][1] - lat) * y);
            let length = (bx - ax).powi(2) + (by - ay).powi(2);
            let t = (-(ax * (bx - ax) + ay * (by - ay)) / if length == 0.0 { 1.0 } else { length }).clamp(0.0, 1.0);
            let (px, py) = (ax + t * (bx - ax), ay + t * (by - ay));
            let meters = px.hypot(py);
            if meters <= best_meters {
                best_meters = meters;
                best = Some([lon + px / x, lat + py / y]);
            }
        }
    }
    best.map(|point| (point, best_meters))
}

/// The suggestions as the app reads them: `[{"label","title","detail"?,"category","coord","street"?}]`.
pub fn places_json(places: &[Place]) -> String {
    let mut out = String::from("[");
    for (i, place) in places.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"label\":");
        push_string(&mut out, &place.label);
        out.push_str(",\"title\":");
        push_string(&mut out, &place.title);
        if let Some(detail) = &place.detail {
            out.push_str(",\"detail\":");
            push_string(&mut out, detail);
        }
        let _ = write!(out, ",\"category\":\"{}\",\"coord\":[", place.category.name());
        push_number(&mut out, place.coord[0]);
        out.push(',');
        push_number(&mut out, place.coord[1]);
        out.push(']');
        if let Some(street) = &place.street {
            out.push_str(",\"street\":");
            push_string(&mut out, street);
        }
        out.push('}');
    }
    out.push(']');
    out
}

/// The label without its postcode, in lower case: "Hauptplatz, 8010 Graz" and "Hauptplatz, Graz" are one.
fn merge_key(label: &str) -> String {
    let mut key = label.to_string();
    if let Some(at) = label.match_indices(", ").map(|(i, _)| i).find(|&i| {
        let rest = &label[i + 2..];
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        (4..=5).contains(&digits) && rest.as_bytes().get(digits) == Some(&b' ')
    }) {
        let digits = label[at + 2..].bytes().take_while(u8::is_ascii_digit).count();
        key.replace_range(at + 2..at + 3 + digits, "");
    }
    key.to_lowercase()
}

fn tag(properties: &Json) -> (&str, &str) {
    let text = |key: &str| properties.get(key).and_then(Json::str).unwrap_or("undefined");
    (text("osm_key"), text("osm_value"))
}

/// Objects no one plans a ride to: stops and platforms (a station is one place), railway works, shelters, parts of
/// buildings, signposts and land registry areas. A building counts as an address, or as what it is when that is a
/// destination (an abbey, a church, a castle, a station).
fn is_clutter(properties: &Json) -> bool {
    let (key, value) = tag(properties);
    let clutter = match key {
        "highway" => matches!(value, "bus_stop" | "platform"),
        "railway" => matches!(
            value,
            "stop"
                | "platform"
                | "signal_box"
                | "car_shuttle"
                | "switch"
                | "crossing"
                | "level_crossing"
                | "subway_entrance"
                | "train_station_entrance"
                | "buffer_stop"
        ),
        "public_transport" | "information" | "landuse" => true,
        "amenity" => value == "shelter",
        "building" => value == "roof",
        _ => false,
    };
    let destination = matches!(
        value,
        "monastery"
            | "castle"
            | "palace"
            | "train_station"
            | "church"
            | "cathedral"
            | "chapel"
            | "school"
            | "university"
            | "hospital"
            | "hotel"
            | "stadium"
            | "museum"
    );
    let house = properties.get("housenumber").and_then(Json::str).is_some_and(|h| !h.is_empty());
    let name = properties.get("name").and_then(Json::str).unwrap_or_default();
    clutter || (key == "building" && !house && !destination) || name.starts_with("Katastralgemeinde ")
}

fn category(properties: &Json) -> Category {
    let (key, value) = tag(properties);
    let text = |k: &str| properties.get(k).and_then(Json::str).is_some_and(|t| !t.is_empty());
    if text("housenumber") && !text("name") {
        Category::Address
    } else if properties.get("type").and_then(Json::str) == Some("street")
        || key == "highway"
        || (key, value) == ("place", "square")
    {
        Category::Street
    } else if key == "place"
        && matches!(
            value,
            "city"
                | "town"
                | "village"
                | "hamlet"
                | "suburb"
                | "quarter"
                | "neighbourhood"
                | "locality"
                | "isolated_dwelling"
                | "municipality"
                | "farm"
        )
    {
        Category::Town
    } else if (key == "natural"
        && ["peak", "volcano", "ridge", "saddle", "mountain_range"].iter().any(|v| value.starts_with(v)))
        || key == "mountain_pass"
    {
        Category::Mountain
    } else if matches!(
        (key, value),
        ("railway", "station" | "halt") | ("building", "train_station") | ("amenity", "bus_station")
    ) {
        Category::Station
    } else if (key == "natural" && ["water", "lake", "bay"].iter().any(|v| value.starts_with(v)))
        || key == "water"
        || key == "waterway"
    {
        Category::Water
    } else {
        Category::Place
    }
}

/// `parsePlace`; None for a feature that is no point or has nothing to call it.
fn parse_place(feature: &Json) -> Option<Place> {
    let geometry = feature.get("geometry")?;
    let properties = feature.get("properties")?;
    let at = geometry.get("coordinates")?.array()?;
    let coord = [at.first()?.number()?, at.get(1)?.number()?];
    if geometry.get("type").and_then(Json::str) != Some("Point") || coord[0].abs() > 180.0 || coord[1].abs() > 90.0 {
        return None;
    }
    let text = |key: &str| properties.get(key).and_then(Json::str).map(str::trim).filter(|t| !t.is_empty());
    let (name, street, house, city) = (text("name"), text("street"), text("housenumber"), text("city"));
    let (postcode, region, country) = (text("postcode"), text("state"), text("country"));
    let street_address = [street, house].into_iter().flatten().collect::<Vec<_>>().join(" ");
    // a postcode without its town (a town's own entry) says nothing on its own
    let locality = city.map(|city| [postcode, Some(city)].into_iter().flatten().collect::<Vec<_>>().join(" "));
    let mut parts: Vec<&str> = Vec::new();
    let candidates =
        [name, (Some(street_address.as_str()) != name).then_some(street_address.as_str()), locality.as_deref(), region];
    for part in candidates.into_iter().flatten().filter(|part| !part.is_empty()) {
        if !parts.contains(&part) {
            parts.push(part);
        }
    }
    let label = parts.join(", ");
    if label.is_empty() {
        return None;
    }
    let category = category(properties);
    let title = match (category, name) {
        (Category::Address, None) | (_, None) => street_address.clone(),
        (_, Some(name)) => name.to_string(),
    };
    // where it is: a town's region (and country abroad); an address's or street's postcode and town; a station's town
    // (its street is often a platform or tunnel); anything else's town first, then its street
    let detail = match category {
        Category::Town => {
            [region, country.filter(|c| *c != "Österreich")].into_iter().flatten().collect::<Vec<_>>().join(", ")
        }
        Category::Address | Category::Street => locality.clone().or(region.map(str::to_string)).unwrap_or_default(),
        Category::Station => city.or(region).unwrap_or_default().to_string(),
        _ => [city.or(region), (street_address != title).then_some(street_address.as_str())]
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · "),
    };
    let street = street.filter(|_| properties.get("type").and_then(Json::str) != Some("street")).map(str::to_string);
    Some(Place {
        label,
        title,
        detail: (!detail.is_empty()).then_some(detail),
        category,
        coord,
        street,
        town: city.map(str::to_string),
    })
}

/// How near a house must be to lend its number, in metres.
const HOUSE_METRES: f64 = 30.0;

/// The name for `at` from the search's answer to `/reverse` (Photon's GeoJSON), or None when it found nothing.
pub fn place_name(answer: &str, at: Coord) -> Option<String> {
    let json = Json::parse(answer).ok()?;
    let feature = json.get("features")?.array()?.first()?;
    let properties = feature.get("properties")?;
    let text = |key: &str| properties.get(key).and_then(Json::str).map(str::trim).filter(|t| !t.is_empty());
    let found = feature.get("geometry").and_then(|g| g.get("coordinates")).and_then(Json::array);
    let near = found
        .and_then(|c| Some([c.first()?.number()?, c.get(1)?.number()?]))
        .is_some_and(|found| distance(at, found) <= HOUSE_METRES);
    let street = text(if text("type") == Some("street") { "name" } else { "street" });
    // a town's own entry names the town itself
    let city = text("city").or(if street.is_some() { None } else { text("name") });
    let first = match street {
        Some(street) => Some(match text("housenumber").filter(|_| near) {
            Some(number) => format!("{street} {number}"),
            None => street.to_string(),
        }),
        None => text("name").map(str::to_string),
    };
    // village addresses repeat the town as the street name ("Mortantsch 21, 8160 Mortantsch")
    let first = first.filter(|first| Some(first.as_str()) != city);
    let town = [text("postcode"), city].into_iter().flatten().collect::<Vec<_>>().join(" ");
    let name =
        [first.unwrap_or_default(), town].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(", ");
    (!name.is_empty()).then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: Coord = [15.4743, 47.0908];

    fn answer(properties: &str, at: Coord) -> String {
        format!(
            r#"{{"features":[{{"type":"Feature","geometry":{{"type":"Point","coordinates":[{},{}]}},"properties":{{{properties}}}}}]}}"#,
            at[0], at[1]
        )
    }

    fn feature(properties: &str, at: Coord) -> String {
        format!(
            r#"{{"type":"Feature","geometry":{{"type":"Point","coordinates":[{},{}]}},"properties":{{{properties}}}}}"#,
            at[0], at[1]
        )
    }

    fn collection(features: &[String]) -> String {
        format!(r#"{{"features":[{}]}}"#, features.join(","))
    }

    const GRAZ: &str = r#""city":"Graz","state":"Steiermark","country":"Österreich""#;

    /// The cases of `tests/geocoding.test.mjs`, from here on those of `forwardGeocode`.
    #[test]
    fn a_name_repeated_within_a_town_is_one_place() {
        let square = |at: Coord, more: &str| feature(&format!(r#""name":"Hauptplatz",{GRAZ}{more}"#), at);
        let answer = collection(&[
            square([15.4385, 47.071], ""),
            square([15.4385, 47.071], ""),
            square([15.44, 47.07], ""),
            square([15.4385, 47.071], r#","postcode":"8010""#),
            square([15.47, 47.05], ""),
            feature(
                r#""name":"Hauptplatz","city":"Gleisdorf","state":"Steiermark","country":"Österreich""#,
                [15.7, 47.1],
            ),
        ]);
        let found = places(&[answer]);
        assert_eq!(found.iter().map(|p| p.town.as_deref()).collect::<Vec<_>>(), [Some("Graz"), Some("Gleisdorf")]);
        assert_eq!(
            found[0],
            Place {
                label: "Hauptplatz, Graz, Steiermark".into(),
                title: "Hauptplatz".into(),
                detail: Some("Graz".into()),
                category: Category::Place,
                coord: [15.4385, 47.071],
                street: None,
                town: Some("Graz".into()),
            }
        );
        assert!(places(&[r#"{"features":[]}"#.into()]).is_empty());
        let invalid = collection(&[feature(r#""name":"Nowhere""#, [181.0, 47.0])]);
        assert!(places(&[invalid]).is_empty(), "a point off the earth is left out");
    }

    #[test]
    fn an_address_knows_its_street_and_a_street_result_does_not_need_one() {
        let house = r#""type":"house","osm_value":"apartments","street":"Musterweg","housenumber":"7","postcode":"8020","city":"Graz""#;
        let found = places(&[collection(&[feature(house, [15.42235, 47.06525])])]);
        assert_eq!(
            (found[0].street.as_deref(), found[0].label.as_str()),
            (Some("Musterweg"), "Musterweg 7, 8020 Graz")
        );
        let street = r#""type":"street","name":"Musterweg","postcode":"8020","city":"Graz""#;
        assert_eq!(places(&[collection(&[feature(street, [15.393, 47.0769])])])[0].street, None);
    }

    #[test]
    fn clutter_goes_while_halts_and_buildings_that_are_destinations_stay() {
        let kind = |name: &str, key: &str, value: &str| {
            feature(&format!(r#""name":"{name}",{GRAZ},"osm_key":"{key}","osm_value":"{value}""#), [15.4385, 47.071])
        };
        let answer = collection(&[
            kind("Weinwarte Sankt Peter", "tourism", "viewpoint"),
            kind("Sankt Peter", "highway", "bus_stop"),
            kind("Dach", "building", "roof"),
            kind("Haus A", "building", "yes"),
            kind("Katastralgemeinde Sankt Peter", "boundary", "administrative"),
            kind("Sankt Peter", "place", "village"),
            kind("Graz Don Bosco", "railway", "halt"),
            kind("Stift Rein", "building", "monastery"),
        ]);
        let found: Vec<_> = places(&[answer]).into_iter().map(|p| (p.title, p.category)).collect();
        let expected = [
            ("Weinwarte Sankt Peter", Category::Place),
            ("Sankt Peter", Category::Town),
            ("Graz Don Bosco", Category::Station),
            ("Stift Rein", Category::Place),
        ];
        assert_eq!(found, expected.map(|(t, c)| (t.to_string(), c)));
    }

    #[test]
    fn a_suggestion_shows_what_a_place_is_and_where() {
        let answer = collection(&[
            feature(
                r#""street":"Herrengasse","housenumber":"5","postcode":"8010","city":"Graz","state":"Steiermark","country":"Österreich""#,
                [15.44, 47.07],
            ),
            feature(
                r#""name":"Gleisdorf","osm_key":"place","osm_value":"town","state":"Steiermark","country":"Österreich""#,
                [15.7, 47.1],
            ),
            feature(
                r#""name":"Schöckl","osm_key":"natural","osm_value":"peak","postcode":"8061","city":"Sankt Radegund bei Graz","state":"Steiermark""#,
                [15.47, 47.2],
            ),
            feature(
                r#""name":"Pizzeria St. Radegund","osm_key":"amenity","osm_value":"restaurant","street":"Hauptstraße","housenumber":"42","postcode":"8061","city":"Sankt Radegund bei Graz","state":"Steiermark""#,
                [15.49, 47.18],
            ),
        ]);
        let found: Vec<_> =
            places(&[answer]).into_iter().map(|p| (p.category, p.title, p.detail.unwrap_or_default())).collect();
        let expected = [
            (Category::Address, "Herrengasse 5", "8010 Graz"),
            (Category::Town, "Gleisdorf", "Steiermark"),
            (Category::Mountain, "Schöckl", "Sankt Radegund bei Graz"),
            (Category::Place, "Pizzeria St. Radegund", "Sankt Radegund bei Graz · Hauptstraße 42"),
        ];
        assert_eq!(found, expected.map(|(c, t, d)| (c, t.to_string(), d.to_string())));
    }

    #[test]
    fn areas_answer_together_the_first_of_a_place_kept() {
        let square = feature(&format!(r#""name":"Hauptplatz",{GRAZ}"#), [15.4385, 47.071]);
        let other = feature(r#""name":"Hauptplatz","city":"Leoben""#, [15.09, 47.38]);
        let found = places(&[collection(std::slice::from_ref(&square)), collection(&[square, other])]);
        assert_eq!(found.len(), 2);
        let json = places_json(&found);
        assert!(json.starts_with(r#"[{"label":"Hauptplatz, Graz, Steiermark","title":"Hauptplatz","detail":"Graz","category":"place","coord":[15.4385,47.071]}"#), "{json}");
    }

    /// The case of `tests/street-point.test.mjs`.
    #[test]
    fn the_nearest_point_on_a_street_within_reach_or_none() {
        let house = [15.42235, 47.06525];
        // Idlhofgasse runs about 115 m east of the house; another street lies farther away
        let idlhofgasse = vec![[15.42395, 47.06504], [15.42365, 47.06639]];
        let far = vec![[15.418, 47.062], [15.418, 47.068]];
        let (point, meters) = nearest_on_lines(house, &[far.clone(), idlhofgasse], 150.0).unwrap();
        assert!(point[0] > house[0] && (distance(house, point) - 115.0).abs() < 5.0, "{point:?}");
        assert!((meters - distance(house, point)).abs() < 1.0);
        assert_eq!(nearest_on_lines(house, &[far], 150.0), None, "out of reach");
        assert_eq!(nearest_on_lines(house, &[], 150.0), None);
    }

    /// The cases of `tests/geocoding.test.mjs` for `reverseGeocode`.
    #[test]
    fn names_the_street_and_town_with_the_house_number_only_when_the_house_is_right_there() {
        let name = |properties: &str, at: Coord| place_name(&answer(properties, at), AT);
        let street = r#""type":"street","name":"Hahnhofweg","postcode":"8010","city":"Graz","state":"Steiermark""#;
        assert_eq!(name(street, AT).as_deref(), Some("Hahnhofweg, 8010 Graz"));
        let house = r#""type":"house","street":"Musterweg","housenumber":"12","postcode":"8020","city":"Graz""#;
        assert_eq!(name(house, [15.4744, 47.0908]).as_deref(), Some("Musterweg 12, 8020 Graz"));
        let far =
            r#""type":"house","street":"Deckerweg","housenumber":"31","postcode":"8063","city":"Eggersdorf bei Graz""#;
        assert_eq!(
            name(far, [15.4755, 47.0908]).as_deref(),
            Some("Deckerweg, 8063 Eggersdorf bei Graz"),
            "a house 90 m away"
        );
        let landmark = r#""type":"house","name":"Wegkreuz","street":"Roseggerweg","postcode":"8044","city":"Graz""#;
        assert_eq!(name(landmark, AT).as_deref(), Some("Roseggerweg, 8044 Graz"), "a landmark gives its street");
        let village =
            r#""type":"house","street":"Mortantsch","housenumber":"21","postcode":"8160","city":"Mortantsch""#;
        assert_eq!(name(village, [15.4743, 47.093]).as_deref(), Some("8160 Mortantsch"));
        let locality = r#""type":"locality","name":"Gollersattel","postcode":"8164","city":"Gutenberg""#;
        assert_eq!(name(locality, AT).as_deref(), Some("Gollersattel, 8164 Gutenberg"));
        assert_eq!(place_name(r#"{"features":[]}"#, AT), None);
        assert_eq!(name(r#""type":"street","name":"  ""#, AT), None, "blank texts count as none");
    }
}

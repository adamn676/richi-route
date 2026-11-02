//! A place's name as the planner gives it (`reverseGeocode`, `app/src/services/geocoding.service.ts`): the street at a
//! point set on the map, with the house number only when that house is right there, and its town.

use crate::json::Json;
use crate::leg::{Coord, distance};

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

    /// The cases of `tests/geocoding.test.mjs`.
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

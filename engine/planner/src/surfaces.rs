//! The route's surfaces as the planner lists them (`inspectSurfaces`, `app/src/domain/route-surfaces.ts`): its
//! sections, each a stretch of one surface group that runs on across the legs' ends, with a piece of a few metres
//! taking the surface around it, and the metres of each group.

use std::fmt::Write;

use crate::json::{Json, push_number, push_string};
use crate::leg::{Coord, along};

/// The groups in the planner's order, from paved to unknown.
const SURFACES: [&str; 5] = ["paved", "likelyPaved", "rough", "unpaved", "unknown"];
/// A piece shorter than this (GPS jitter where a track stops, a kerb) is no section of its own.
const SLIVER_METERS: f64 = 10.0;

/// A leg as the planner sends it: its points and its spans `(from, to, surface, corrected)`.
pub struct Surfaced<'a> {
    pub coordinates: Vec<Coord>,
    pub spans: Vec<(usize, usize, &'a str, bool)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Section<'a> {
    /// `(leg, from, to)`: one part on each leg the section runs over.
    pub parts: Vec<(usize, usize, usize)>,
    pub from: f64,
    pub to: f64,
    pub surface: &'a str,
    pub corrected: bool,
}

impl Section<'_> {
    fn length(&self) -> f64 {
        self.to - self.from
    }
}

/// `inspectSurfaces`: the sections along the legs, and their total length.
pub fn sections<'a>(legs: &[Surfaced<'a>]) -> (Vec<Section<'a>>, f64) {
    let mut pieces = Vec::new();
    let mut offset = 0.0;
    for (index, leg) in legs.iter().enumerate() {
        let distances = along(&leg.coordinates);
        let mut add = |from: usize, to: usize, surface: &'a str, corrected: bool| {
            if to > from && distances[to] != distances[from] {
                let (from_meters, to_meters) = (offset + distances[from], offset + distances[to]);
                pieces.push(Section {
                    parts: vec![(index, from, to)],
                    from: from_meters,
                    to: to_meters,
                    surface,
                    corrected,
                });
            }
        };
        let mut cursor = 0;
        for &(from, to, surface, corrected) in &leg.spans {
            add(cursor, from, "unknown", false);
            add(from, to, surface, corrected);
            cursor = to;
        }
        add(cursor, leg.coordinates.len().saturating_sub(1), "unknown", false);
        offset += distances[distances.len() - 1];
    }
    (settle(pieces), offset)
}

/// A sliver joins its neighbours where both are of one surface, otherwise its longer neighbour; what the rider
/// corrected stays as it is.
fn settle(pieces: Vec<Section>) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    for i in 0..pieces.len() {
        let mut piece = pieces[i].clone();
        if piece.length() < SLIVER_METERS && !piece.corrected {
            let neighbours: Vec<&Section> =
                [sections.last(), pieces.get(i + 1)].into_iter().flatten().filter(|s| !s.corrected).collect();
            let into = match neighbours[..] {
                [a, b] if a.surface == b.surface => Some(a),
                // the longer, the earlier where both are as long (a stable sort)
                [a, b] => Some(if b.length() > a.length() { b } else { a }),
                [a] => Some(a),
                _ => None,
            };
            if let Some(into) = into {
                piece.surface = into.surface;
            }
        }
        join(&mut sections, piece);
    }
    sections
}

/// Neighbouring stretches of the same kind are one section, whatever their materials and legs.
fn join<'a>(sections: &mut Vec<Section<'a>>, piece: Section<'a>) {
    let Some(previous) = sections.last_mut().filter(|previous| {
        previous.to == piece.from && previous.surface == piece.surface && previous.corrected == piece.corrected
    }) else {
        return sections.push(piece);
    };
    for part in piece.parts {
        match previous.parts.last_mut() {
            Some(last) if last.0 == part.0 && last.2 == part.1 => last.2 = part.2,
            _ => previous.parts.push(part),
        }
    }
    previous.to = piece.to;
}

/// The sections for a request `{"legs":[{"coordinates":[[lon,lat],…],"surfaces":[{"fromIndex","toIndex","surface",
/// "osm"?},…]},…]}`, the legs as the planner keeps them, as `{"distance","totals":[{"surface","meters"}],
/// "sections":[{"from","to","surface","corrected","parts":[[leg,from,to],…]}]}`.
pub fn surfaces_request(body: &str) -> Result<String, String> {
    let json = Json::parse(body)?;
    let legs = json.get("legs").and_then(Json::array).ok_or("legs missing")?;
    let legs = legs
        .iter()
        .map(|leg| {
            let coordinates: Vec<Coord> = leg
                .get("coordinates")
                .and_then(Json::array)
                .ok_or("coordinates missing")?
                .iter()
                .map(|c| Some([c.array()?.first()?.number()?, c.array()?.get(1)?.number()?]))
                .collect::<Option<_>>()
                .ok_or("a coordinate is not [lon, lat]")?;
            let spans = leg
                .get("surfaces")
                .and_then(Json::array)
                .unwrap_or_default()
                .iter()
                .map(|span| {
                    let index = |key| span.get(key).and_then(Json::number).map(|n| n as usize);
                    let surface = span.get("surface").and_then(Json::str).filter(|s| SURFACES.contains(s))?;
                    let (from, to) = (index("fromIndex")?, index("toIndex")?);
                    (from <= to && to < coordinates.len()).then_some((from, to, surface, span.get("osm").is_some()))
                })
                .collect::<Option<_>>()
                .ok_or("a span is not {fromIndex, toIndex, surface} on the leg")?;
            Ok(Surfaced { coordinates, spans })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let (sections, total) = sections(&legs);

    let mut out = String::from("{\"distance\":");
    push_number(&mut out, total);
    out.push_str(",\"totals\":[");
    let totals = SURFACES.into_iter().filter(|&surface| sections.iter().any(|s| s.surface == surface));
    for (i, surface) in totals.enumerate() {
        let meters: f64 = sections.iter().filter(|s| s.surface == surface).map(Section::length).sum();
        out.push_str(if i > 0 { ",{\"surface\":" } else { "{\"surface\":" });
        push_string(&mut out, surface);
        out.push_str(",\"meters\":");
        push_number(&mut out, meters);
        out.push('}');
    }
    out.push_str("],\"sections\":[");
    for (i, section) in sections.iter().enumerate() {
        out.push_str(if i > 0 { ",{\"from\":" } else { "{\"from\":" });
        push_number(&mut out, section.from);
        out.push_str(",\"to\":");
        push_number(&mut out, section.to);
        out.push_str(",\"surface\":");
        push_string(&mut out, section.surface);
        let _ = write!(out, ",\"corrected\":{},\"parts\":[", section.corrected);
        for (j, (leg, from, to)) in section.parts.iter().enumerate() {
            let _ = write!(out, "{}[{leg},{from},{to}]", if j > 0 { "," } else { "" });
        }
        out.push_str("]}");
    }
    out.push_str("]}");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A straight leg north from Graz with a point every `step` metres.
    fn leg(points: usize, step: f64, spans: Vec<(usize, usize, &str, bool)>) -> Surfaced<'_> {
        Surfaced { coordinates: (0..points).map(|i| [15.44, 47.07 + i as f64 * step / 111_195.0]).collect(), spans }
    }

    #[test]
    fn a_sliver_takes_the_surface_around_it_and_sections_run_across_legs() {
        let legs = [
            leg(5, 100.0, vec![(0, 2, "paved", false), (2, 3, "unpaved", false), (3, 4, "paved", false)]),
            leg(3, 5.0, vec![(0, 2, "paved", false)]),
        ];
        // the 100 m of gravel stays; the second leg's 10 m of road joins the first leg's last stretch
        let (found, _) = sections(&legs);
        let shown: Vec<_> = found.iter().map(|s| (s.surface, s.parts.clone())).collect();
        assert_eq!(
            shown,
            [("paved", vec![(0, 0, 2)]), ("unpaved", vec![(0, 2, 3)]), ("paved", vec![(0, 3, 4), (1, 0, 2)])]
        );

        // 4 m of gravel between two roads of 100 m
        let along = |meters: f64| [15.44, 47.07 + meters / 111_195.0];
        let spans = vec![(0, 1, "paved", false), (1, 2, "unpaved", false), (2, 3, "paved", false)];
        let sliver = [Surfaced { coordinates: vec![along(0.0), along(100.0), along(104.0), along(204.0)], spans }];
        let (found, _) = sections(&sliver);
        assert_eq!(
            found.iter().map(|s| (s.surface, s.parts.clone())).collect::<Vec<_>>(),
            [("paved", vec![(0, 0, 3)])]
        );
    }

    #[test]
    fn corrected_stretches_stay_their_own_and_gaps_are_unknown() {
        let legs = [leg(4, 100.0, vec![(1, 2, "paved", true), (2, 3, "paved", false)])];
        let (found, total) = sections(&legs);
        assert_eq!(
            found.iter().map(|s| (s.surface, s.corrected)).collect::<Vec<_>>(),
            [("unknown", false), ("paved", true), ("paved", false)]
        );
        assert!((total - 300.0).abs() < 0.1, "{total}");
    }

    #[test]
    fn requests_answer_totals_in_the_planners_order() {
        let body = r#"{"legs":[{"coordinates":[[15.44,47.07],[15.44,47.071],[15.44,47.072]],
            "surfaces":[{"fromIndex":0,"toIndex":1,"surface":"unpaved"},{"fromIndex":1,"toIndex":2,"surface":"paved","osm":{"surface":"unpaved"}}]}]}"#;
        let answer = surfaces_request(body).unwrap();
        assert!(answer.contains(r#""totals":[{"surface":"paved","meters":111.19"#), "{answer}");
        assert!(answer.contains(r#""surface":"paved","corrected":true,"parts":[[0,1,2]]"#), "{answer}");
        assert!(surfaces_request(&body.replace("\"paved\"", "\"gravel\"")).is_err());
    }
}

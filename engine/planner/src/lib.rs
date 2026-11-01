//! The planner's own logic on top of the engine, one implementation for the web planner and the iPhone
//! app. So far: the loop suggestions, which the routing server answers at `/loops` (`LoopRequest`). The
//! routes they need run on the server's `RouterPool` side by side, as `/brouter` requests would.

mod json;
mod leg;
mod loops;

use std::fmt::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use brouter_router::{Answer, Outcome, RouterPool};
use brouter_util::jmath;

use json::{Json, push_string};
use leg::push_coords;
pub use leg::{Coord, Leg};
pub use loops::{Earlier, Stop, Suggestion, Target};
use loops::{Routed, Trip, suggest_loops};

/// Why a route failed: the engine's outcome (its error, an exception or a panic), or an internal error
/// (an answer the planner cannot read, a reply lost).
pub enum Failure {
    Engine(Outcome),
    Internal(String),
}

/// A request for loop suggestions, with the profile and its parameters the planner routes with.
pub struct LoopRequest {
    profile: String,
    parameters: Vec<(String, String)>,
    pub start: Coord,
    pub target: Target,
    pub dice: Vec<f64>,
    pub earlier: Vec<Earlier>,
}

impl LoopRequest {
    /// The JSON body `{"profile", "parameters": {name: value as text}, "start": [lon, lat], "target":
    /// {"meters", "ascent"}, "random", "earlier"}`: `random` up to 13 numbers from 0 to 1 (see
    /// `suggest_loops`), `earlier` the squares of loops suggested before with their weights
    /// (`[{"cells": [...], "weight"}]`); both may be left out.
    pub fn parse(body: &str) -> Result<Self, String> {
        let json = Json::parse(body)?;
        let number = |value: Option<&Json>, name: &str| {
            value.and_then(Json::number).filter(|n| n.is_finite()).ok_or(format!("{name} must be a number"))
        };
        let text = |value: &Json, name: &str| value.str().map(str::to_string).ok_or(format!("{name} must be text"));
        let list = |name: &str| match json.get(name) {
            None => Ok(&[][..]),
            Some(value) => value.array().ok_or(format!("{name} must be a list")),
        };
        let profile = text(json.get("profile").unwrap_or(&Json::Null), "profile")?;
        let parameters = match json.get("parameters") {
            None => Vec::new(),
            Some(Json::Object(members)) => members
                .iter()
                .map(|(name, value)| Ok((name.clone(), text(value, name)?)))
                .collect::<Result<_, String>>()?,
            Some(_) => return Err("parameters must be an object".into()),
        };
        let start = json.get("start").and_then(Json::array).unwrap_or_default();
        let start = match start {
            [lon, lat] => [number(Some(lon), "start")?, number(Some(lat), "start")?],
            _ => [f64::NAN; 2],
        };
        if !(start[0].abs() <= 180.0 && start[1].abs() <= 90.0) {
            return Err("start must be [longitude, latitude]".into());
        }
        let target = json.get("target");
        let target = Target {
            meters: number(target.and_then(|t| t.get("meters")), "target.meters")?,
            ascent: number(target.and_then(|t| t.get("ascent")), "target.ascent")?,
        };
        if target.meters <= 0.0 {
            return Err("target.meters must be positive".into());
        }
        let dice = list("random")?.iter().map(|d| number(Some(d), "random")).collect::<Result<Vec<_>, _>>()?;
        if dice.iter().any(|d| !(0.0..1.0).contains(d)) {
            return Err("random must be numbers from 0 to 1".into());
        }
        let earlier = list("earlier")?
            .iter()
            .map(|e| {
                let cells = e.get("cells").and_then(Json::array).ok_or("earlier cells must be a list")?;
                let cells = cells.iter().map(|cell| text(cell, "a cell")).collect::<Result<_, _>>()?;
                Ok(Earlier { cells, weight: number(e.get("weight"), "earlier weight")? })
            })
            .collect::<Result<_, String>>()?;
        Ok(LoopRequest { profile, parameters, start, target, dice, earlier })
    }

    /// The suggestions, routed on `pool`; `gone` says when the client has gone away, and its searches
    /// then stop.
    pub fn suggest(
        &self,
        pool: &RouterPool,
        max_running_time: i64,
        gone: impl Fn() -> bool,
    ) -> Result<Vec<Suggestion>, Stop<Failure>> {
        suggest_loops(self.start, self.target, &self.dice, &self.earlier, |trips| {
            self.route(pool, trips, max_running_time, &gone)
        })
    }

    /// The trips side by side, in order, or why the search ends: the client has gone, or a reply was lost.
    /// At most as many trips as the pool has threads wait or run at a time, each an ordinary request, so
    /// that requests arriving meanwhile take turns with them instead of waiting for the whole search.
    fn route(
        &self,
        pool: &RouterPool,
        trips: &[Trip],
        max_running_time: i64,
        gone: &impl Fn() -> bool,
    ) -> Routed<Failure> {
        let terminated = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::channel();
        let mut sender = Some(sender);
        let mut legs: Vec<_> = trips.iter().map(|_| None).collect();
        let (mut asked, mut running) = (0, 0);
        for _ in trips {
            while running < pool.threads() && asked < trips.len() {
                let i = asked;
                // the last trip takes the sender itself, so that a reply the pool drops disconnects the channel
                let Some(reply) = (if i + 1 == trips.len() { sender.take() } else { sender.clone() }) else { break };
                pool.submit(self.query(&trips[i]), max_running_time, Some(terminated.clone()), move |outcome, _| {
                    let leg = match outcome {
                        Ok(Ok(Answer::GeoJson(geojson))) => Leg::from_geojson(&geojson).map_err(Failure::Internal),
                        outcome => Err(Failure::Engine(outcome)),
                    };
                    reply.send((i, leg)).unwrap_or_default();
                });
                (asked, running) = (asked + 1, running + 1);
            }
            let (i, leg) = loop {
                match receiver.recv_timeout(Duration::from_millis(100)) {
                    Ok(answer) => break answer,
                    Err(RecvTimeoutError::Timeout) if !gone() => {}
                    Err(RecvTimeoutError::Timeout) => {
                        terminated.store(true, Relaxed);
                        return Err(Stop::Aborted);
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        terminated.store(true, Relaxed);
                        return Err(Stop::Failed(Failure::Internal("the pool dropped a search".into())));
                    }
                }
            };
            legs[i] = Some(leg);
            running -= 1;
        }
        Ok(legs.into_iter().flatten().collect())
    }

    /// The query for a trip as the planner's route service builds it (`request` in `route.service.ts`):
    /// the same parameters in the same order, which can matter to BRouter's `HashMap`.
    fn query(&self, trip: &Trip) -> String {
        let lonlat = |c: Coord| format!("{},{}", c[0], c[1]);
        let (lonlats, extra) = match *trip {
            Trip::Round { radius, direction, points } => (
                lonlat(self.start),
                format!(
                    "&engineMode=4&roundTripDistance={}&direction={direction}&roundTripPoints={points}",
                    jmath::round(radius)
                ),
            ),
            Trip::ThereAndBack { turn } => ([self.start, turn, self.start].map(lonlat).join("|"), String::new()),
        };
        let mut query = format!(
            "profile={}&lonlats={}&format=geojson&alternativeidx=0{extra}",
            encode(&self.profile),
            encode(&lonlats)
        );
        for (name, value) in &self.parameters {
            let _ = write!(query, "&profile%3A{}={}", encode(name), encode(value));
        }
        query
    }
}

/// Percent-encoding for a query value.
fn encode(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.*".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

/// The suggestions as the planner reads them: `[{"leg", "heading", "cells", "back", "along"}]`, the leg
/// as `LegGeometry`.
pub fn suggestions_json(suggestions: &[Suggestion]) -> String {
    let mut out = String::from("[");
    for (i, suggestion) in suggestions.iter().enumerate() {
        out.push_str(if i > 0 { ",{\"leg\":" } else { "{\"leg\":" });
        suggestion.leg.push_json(&mut out);
        out.push_str(",\"heading\":");
        push_string(&mut out, suggestion.heading);
        out.push_str(",\"cells\":[");
        for (j, cell) in suggestion.cells.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            push_string(&mut out, cell);
        }
        let _ = write!(out, "],\"back\":{},\"along\":", suggestion.back);
        push_coords(&mut out, &suggestion.along);
        out.push('}');
    }
    out.push(']');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = r#"{"profile": "richi-local-v1", "parameters": {"pass1coefficient": "2", "richiroute_rules": "a b"},
        "start": [15.4395, 47.0707], "target": {"meters": 60000, "ascent": 600}, "random": [0.5, 0.25],
        "earlier": [{"cells": ["1,2", "3,4"], "weight": 0.75}]}"#;

    #[test]
    fn requests_name_the_profile_start_target_dice_and_earlier_loops() {
        let request = LoopRequest::parse(BODY).unwrap();
        assert_eq!(request.start, [15.4395, 47.0707]);
        assert_eq!(request.target, Target { meters: 60_000.0, ascent: 600.0 });
        assert_eq!(request.dice, [0.5, 0.25]);
        assert_eq!(request.earlier, [Earlier { cells: vec!["1,2".into(), "3,4".into()], weight: 0.75 }]);
        let minimal =
            LoopRequest::parse(r#"{"profile": "p", "start": [15, 47], "target": {"meters": 1, "ascent": 0}}"#);
        assert!(minimal.is_ok_and(|r| r.dice.is_empty() && r.earlier.is_empty() && r.parameters.is_empty()));
        for bad in [
            BODY.replace("[0.5, 0.25]", "[1]"),
            BODY.replace("\"2\"", "2"),
            BODY.replace("[15.4395, 47.0707]", "[15.4395, 97]"),
            BODY.replace("60000", "0"),
            BODY.replace("0.75", "\"0.75\""),
            BODY.replace("\"profile\"", "\"profiles\""),
            BODY[1..].to_string(),
        ] {
            assert!(LoopRequest::parse(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn trips_are_asked_as_the_planner_asks_for_routes() {
        let request = LoopRequest::parse(BODY).unwrap();
        let round = Trip::Round { radius: 9677.4, direction: 30.0, points: 5 };
        assert_eq!(
            request.query(&round),
            "profile=richi-local-v1&lonlats=15.4395%2C47.0707&format=geojson&alternativeidx=0&engineMode=4&\
             roundTripDistance=9677&direction=30&roundTripPoints=5&profile%3Apass1coefficient=2&profile%3Arichiroute_rules=a%20b"
        );
        let back = request.query(&Trip::ThereAndBack { turn: [15.5, 47.123_456_789] });
        assert!(back.contains("&lonlats=15.4395%2C47.0707%7C15.5%2C47.123456789%7C15.4395%2C47.0707&format"), "{back}");
    }

    #[test]
    fn suggestions_go_out_as_the_planner_reads_them() {
        let leg = Leg {
            coordinates: vec![[15.0, 47.0], [15.5, 47.25]],
            elevations: None,
            distance: 1.5,
            ascent: None,
            surfaces: vec![],
        };
        let suggestion =
            Suggestion { leg, heading: "Süden", cells: vec!["1,-2".into()], back: true, along: vec![[15.5, 47.25]] };
        assert_eq!(
            suggestions_json(&[suggestion]),
            r#"[{"leg":{"coordinates":[[15,47],[15.5,47.25]],"elevations":null,"distanceMeters":1.5,"ascentMeters":null,"surfaces":[]},"heading":"Süden","cells":["1,-2"],"back":true,"along":[[15.5,47.25]]}]"#
        );
        assert_eq!(suggestions_json(&[]), "[]");
    }
}

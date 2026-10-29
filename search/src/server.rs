//! Answers the planner as Photon does: `GET /api/?q=…` and `GET /reverse?lat=…&lon=…`, each a GeoJSON
//! FeatureCollection of points with Photon's properties (name, street, housenumber, postcode, city, state, country,
//! osm_key, osm_value, type). One request per connection, on a thread of its own.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use crate::geo::Point;
use crate::index::{Doc, House, Index};
use crate::search::{DEFAULT_BIAS_SCALE, Hit, Query, Spot, TypoIndex, reverse, search, town_at};

pub struct Service {
    pub index: Index,
    pub typos: TypoIndex,
}

pub fn serve(listener: &TcpListener, service: Service) -> ! {
    let service = Arc::new(service);
    for stream in listener.incoming().flatten() {
        let service = service.clone();
        std::thread::spawn(move || respond(stream, &service));
    }
    unreachable!("the listener accepts connections forever");
}

fn respond(mut stream: TcpStream, service: &Service) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut lines = BufReader::new(&stream).lines();
    let request = lines.next().and_then(Result::ok).unwrap_or_default();
    if !lines.by_ref().map_while(Result::ok).any(|line| line.is_empty()) {
        return send(&mut stream, "400 Bad Request", "text/plain", "");
    }
    let target = request.split(' ').nth(1).unwrap_or_default();
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let params = parameters(query);
    let get = |name: &str| params.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    let number = |name: &str| get(name).and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite());
    let point = number("lon").zip(number("lat"));
    let body = match path.trim_end_matches('/') {
        "/api" => {
            let bbox = get("bbox").and_then(|b| {
                let v: Vec<f64> = b.split(',').filter_map(|x| x.parse().ok()).collect();
                (v.len() == 4).then(|| [v[0], v[1], v[2], v[3]])
            });
            let query = Query {
                text: get("q").unwrap_or_default(),
                focus: point,
                bias_scale: number("location_bias_scale").unwrap_or(DEFAULT_BIAS_SCALE),
                bbox,
                limit: number("limit").map_or(15, |l| l.clamp(1.0, 50.0) as usize),
            };
            let index = &service.index;
            let features: Vec<String> = search(index, &service.typos, &query)
                .into_iter()
                .map(|(hit, _)| match hit {
                    Hit::Doc(d) => doc_feature(index, &index.docs[d as usize]),
                    Hit::House(h) => house_feature(index, &index.houses[h as usize]),
                })
                .collect();
            collection(&features)
        }
        "/reverse" => {
            let Some(p) = point else { return send(&mut stream, "400 Bad Request", "text/plain", "lat and lon\n") };
            let radius = number("radius").unwrap_or(1.0).clamp(0.01, 10.0);
            let index = &service.index;
            let towns =
                params.iter().any(|(k, v)| k == "layer" && matches!(v.as_str(), "city" | "locality" | "district"));
            let feature = if towns {
                town_at(index, p, radius).map(|town| {
                    feature(
                        p,
                        &[
                            ("name", town),
                            ("city", town),
                            ("osm_key", "place"),
                            ("osm_value", "town"),
                            ("type", "city"),
                        ],
                    )
                })
            } else {
                reverse(index, p, radius).map(|spot| match spot {
                    Spot::House(house) => house_feature(index, house),
                    Spot::Road { name, near, at } => {
                        let mut properties =
                            vec![("name", name), ("osm_key", "highway"), ("osm_value", "road"), ("type", "street")];
                        if let Some(house) = near {
                            let street = &index.docs[house.street as usize];
                            properties.extend(place_of(index, street, house.postcode));
                        }
                        feature(at, &properties)
                    }
                })
            };
            collection(&feature.into_iter().collect::<Vec<_>>())
        }
        _ => return send(&mut stream, "404 Not Found", "text/plain", ""),
    };
    send(&mut stream, "200 OK", "application/json; charset=utf-8", &body);
}

/// The properties among `keys` that have a text.
fn texts<'a, const N: usize>(
    index: &'a Index,
    keys: [(&'static str, u32); N],
) -> impl Iterator<Item = (&'static str, &'a str)> {
    keys.into_iter().filter_map(|(key, id)| index.text(id).map(|text| (key, text)))
}

/// Postcode, town, state and country of a place.
fn place_of<'a>(index: &'a Index, doc: &Doc, postcode: u32) -> impl Iterator<Item = (&'static str, &'a str)> {
    let region = &index.regions[doc.region as usize];
    texts(index, [("postcode", postcode), ("city", doc.city), ("state", region.state), ("country", region.country)])
}

fn doc_feature(index: &Index, doc: &Doc) -> String {
    let kind = &index.kinds[doc.kind as usize];
    let mut properties =
        vec![("osm_key", kind.key.as_str()), ("osm_value", kind.value.as_str()), ("type", kind.kind_type.as_str())];
    properties.extend(texts(index, [("name", doc.name), ("street", doc.street), ("housenumber", doc.housenumber)]));
    properties.extend(place_of(index, doc, doc.postcode));
    feature(doc.point(), &properties)
}

fn house_feature(index: &Index, house: &House) -> String {
    let street = &index.docs[house.street as usize];
    let mut properties = vec![("osm_key", "place"), ("osm_value", "house"), ("type", "house")];
    properties.extend(texts(index, [("street", street.name), ("housenumber", house.number)]));
    properties.extend(place_of(index, street, house.postcode));
    feature(house.point(), &properties)
}

fn feature(p: Point, properties: &[(&str, &str)]) -> String {
    let properties: Vec<String> = properties.iter().map(|(k, v)| format!("{}:{}", json(k), json(v))).collect();
    format!(
        r#"{{"type":"Feature","geometry":{{"type":"Point","coordinates":[{:.7},{:.7}]}},"properties":{{{}}}}}"#,
        p.0,
        p.1,
        properties.join(",")
    )
}

fn collection(features: &[String]) -> String {
    format!(r#"{{"type":"FeatureCollection","features":[{}]}}"#, features.join(","))
}

fn json(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The parameters of a query string, decoded (`+` is a space).
fn parameters(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (decode(k), decode(v))
        })
        .collect()
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                match std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                    Some(b) => {
                        out.push(b);
                        i += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The answer in one write: header and body in two would wait for the client's acknowledgement in between.
fn send(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let answer = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(answer.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_parameters() {
        assert_eq!(
            parameters("q=Graz+Hbf&lat=47.07&q2=Sch%C3%B6ckl"),
            [
                ("q".to_string(), "Graz Hbf".to_string()),
                ("lat".to_string(), "47.07".to_string()),
                ("q2".to_string(), "Schöckl".to_string()),
            ]
        );
        assert_eq!(decode("100%"), "100%");
    }
}

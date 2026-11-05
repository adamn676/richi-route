//! The planner's routing server, as `LocalRulesServer` (BRouter's `RouteServer` with the local rules)
//! answers: one request per connection, `GET /brouter?<query>`. 200 with the GeoJSON, 400 with the
//! routing error or the rules version mismatch, 500 for any other exception, 404 without `lonlats` and
//! `profile` or on another path. Unlike Java it queues requests beyond the pool's threads instead of stopping the oldest (a
//! search stops instead when its client goes away), never compresses, and answers GeoJSON whatever
//! `format` asks for (`trackname` names only the file). It sends no `Access-Control-Allow-Origin`: the
//! planner reaches it through its own server, so other web pages cannot read its answers.
//!
//! `GET /leg?<query>` routes as `/brouter` does and answers the leg the planner keeps, as JSON
//! (`richi_planner::leg_json`), or the same failure.
//!
//! `GET /name?lat=…&lon=…` names a point as the planner does (`richi_planner::place_name`), and `GET /places?q=…` answers
//! its suggestions for a search (`richi_planner::places_json`), and `GET /street?lat=…&lon=…&name=…` where an address
//! meets its own street, from the address search of the offline areas (`Places`, the iPhone app's), `{"name":null}`,
//! `[]` and `{"point":null}` without them.
//!
//! `POST /loops` with a JSON body (`richi_planner::LoopRequest`, `Content-Type: application/json`)
//! answers the planner's loop suggestions as JSON (`richi_planner::suggestions_json`); where no
//! direction has a loop, the first direction's failure as `/brouter` would answer it, 400 for a
//! malformed request, 405 and 415 for another method or content type.
//!
//! `POST /fit` with a route as JSON, under the same rules, answers its FIT courses, every part of a long
//! one, as JSON with the files in base64 (`richi_planner::course_fits`), and `POST /profile` and `POST /surfaces` with
//! the route's legs its elevation profile and its surface sections as the planner shows them
//! (`richi_planner::profile_request`, `surfaces_request`).

use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime};

use brouter_router::{Answer, Outcome, RouterPool, UrlParams, VERSION_MISMATCH, get_url_params, panic_message};
use richi_planner::{
    Failure, LoopRequest, SEARCH_LIMIT, Stop, course_fits, leg_json, nearest_on_lines, place_name, places, places_json,
    profile_request, push_number, push_string, suggestions_json, surfaces_request,
};
use richi_search::index::Index;
use richi_search::photon;
use richi_search::search::TypoIndex;

/// BRouter's server default (`maxRunningTime`), for engine mode 0.
pub const MAX_RUNNING_TIME_MS: i64 = 60_000;

/// The largest request body: the squares of the loops suggested lately take a few megabytes at most, the
/// track of a 1,000 km route under one.
const MAX_BODY: usize = 8 << 20;

/// The address search of the offline areas in a folder, `<area>/search.index` each, read on first use.
pub struct Places {
    folder: PathBuf,
    areas: OnceLock<Vec<Area>>,
}

struct Area {
    index: Index,
    typos: TypoIndex,
    /// West, south, east and north of its places.
    bounds: [f64; 4],
}

impl Area {
    fn new(index: Index) -> Area {
        let bounds =
            index.docs.iter().map(|doc| doc.point()).fold(
                [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY],
                |[w, s, e, n], (lon, lat)| [w.min(lon), s.min(lat), e.max(lon), n.max(lat)],
            );
        Area { typos: TypoIndex::new(&index), index, bounds }
    }

    fn covers(&self, [lon, lat]: [f64; 2]) -> bool {
        (self.bounds[0]..=self.bounds[2]).contains(&lon) && (self.bounds[1]..=self.bounds[3]).contains(&lat)
    }

    fn ask(&self, path: &str, query: &str) -> Option<String> {
        match photon::answer(&self.index, &self.typos, path, query) {
            photon::Answer::Json(json) => Some(json),
            _ => None,
        }
    }
}

impl Places {
    pub fn new(folder: PathBuf) -> Places {
        Places { folder, areas: OnceLock::new() }
    }

    fn areas(&self) -> &[Area] {
        self.areas.get_or_init(|| {
            let files = std::fs::read_dir(&self.folder).into_iter().flatten().flatten();
            let indexes = files.filter_map(|area| {
                let file = std::fs::File::open(area.path().join("search.index")).ok()?;
                Index::read(BufReader::new(file)).ok()
            });
            indexes.map(Area::new).collect()
        })
    }

    /// The planner's name for a point set on the map (`place_name`), from the first area that knows one.
    pub fn name(&self, at: [f64; 2]) -> Option<String> {
        let query = format!("lat={}&lon={}&lang=de&limit=1&radius=0.3", at[1], at[0]);
        self.areas()
            .iter()
            .filter(|area| area.covers(at))
            .find_map(|area| place_name(&area.ask("/reverse", &query)?, at))
    }

    /// The point on `street` nearest an address at `at`, within 150 m (`pointOnStreet`): a house's centre can lie
    /// nearer a path behind it (a park, a yard) than its street, and snapping alone would start the route there.
    pub fn on_street(&self, at: [f64; 2], street: &str) -> Option<[f64; 2]> {
        const REACH: f64 = 150.0;
        let street = street.to_lowercase();
        let piece = |area: &Area, i: u32| {
            let (a, b) = area.index.road_piece(i);
            vec![[a.0, a.1], [b.0, b.1]]
        };
        let found = self.areas().iter().filter(|area| area.covers(at)).filter_map(|area| {
            let named =
                |i: u32| area.index.text(area.index.road_name(i)).is_some_and(|name| name.to_lowercase() == street);
            let metres =
                |i: u32| nearest_on_lines(at, &[piece(area, i)], REACH).map_or(f64::INFINITY, |(_, m)| m / 1000.0);
            let (i, _) = area
                .index
                .road_grid
                .nearest((at[0], at[1]), REACH / 1000.0, |i| if named(i) { metres(i) } else { f64::INFINITY })?;
            nearest_on_lines(at, &[piece(area, i)], REACH)
        });
        found.min_by(|a, b| a.1.total_cmp(&b.1)).map(|(point, _)| point)
    }

    /// The planner's suggestions for `q` (as the request sent it, percent-encoded), places near `focus` first.
    pub fn search(&self, q: &str, focus: Option<[f64; 2]>) -> String {
        let near = focus.map_or(String::new(), |[lon, lat]| format!("&lat={lat}&lon={lon}&location_bias_scale=0.5"));
        let query = format!("q={q}&lang=de&limit={SEARCH_LIMIT}&bbox={ROUTING_BOUNDS}{near}");
        let mut areas: Vec<&Area> = self.areas().iter().collect();
        // the area around the map answers first
        areas.sort_by_key(|area| !focus.is_some_and(|at| area.covers(at)));
        let answers: Vec<String> = areas.iter().filter_map(|area| area.ask("/api/", &query)).collect();
        places_json(&places(&answers))
    }
}

/// The routing data's rectangle, west, south, east, north (`ROUTING_BOUNDS`, `app/src/config/map.config.ts`).
const ROUTING_BOUNDS: &str = "5,45,20,50";

/// Answers the connections to `listener`, each search ending after `max_running_time` ms; `places` names points.
pub fn serve(listener: &TcpListener, pool: RouterPool, places: Option<Places>, max_running_time: i64) -> ! {
    let pool = Arc::new(pool);
    let places = Arc::new(places);
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let (pool, places) = (pool.clone(), places.clone());
                std::thread::spawn(move || respond(stream, &pool, places.as_ref().as_ref(), max_running_time));
            }
            // out of file handles, or a socket the system took back: try again shortly instead of spinning
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    unreachable!("the listener accepts connections forever");
}

/// `RouteServer.run` for one connection.
fn respond(stream: TcpStream, pool: &RouterPool, places: Option<&Places>, max_running_time: i64) {
    // a client that stops sending before the headers (and the body) end is dropped
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut reader = BufReader::new(&stream);
    let mut lines = reader.by_ref().lines();
    let request = lines.next().and_then(Result::ok);
    let (mut length, mut json) = (0, false);
    loop {
        match lines.next() {
            Some(Ok(line)) if line.is_empty() => break,
            Some(Ok(line)) => match line.split_once(':') {
                Some((name, value)) if name.eq_ignore_ascii_case("content-length") => {
                    length = value.trim().parse().unwrap_or(usize::MAX);
                }
                Some((name, value)) if name.eq_ignore_ascii_case("content-type") => {
                    let mime = value.split(';').next().unwrap_or_default().trim();
                    json = mime.eq_ignore_ascii_case("application/json");
                }
                _ => {}
            },
            _ => return send(stream, "400 Bad Request", ""),
        }
    }
    let mut request = request.as_deref().unwrap_or_default().split(' ');
    let (method, target) = (request.next().unwrap_or_default(), request.next().unwrap_or_default());
    if matches!(target, "/loops" | "/fit" | "/profile" | "/surfaces") {
        // only what a web page cannot send to another site without asking first (no CORS preflight)
        if method != "POST" {
            return send(stream, "405 Method Not Allowed", "");
        }
        if !json {
            return send(stream, "415 Unsupported Media Type", "");
        }
        let mut body = Vec::new();
        if length > MAX_BODY || !reader.take(length as u64).read_to_end(&mut body).is_ok_and(|read| read == length) {
            return send(stream, "400 Bad Request", "");
        }
        let body = String::from_utf8_lossy(&body);
        return match target {
            "/fit" => fit(stream, &body),
            "/profile" => send_json(stream, profile_request(&body)),
            "/surfaces" => send_json(stream, surfaces_request(&body)),
            _ => loops(stream, &body, pool, max_running_time),
        };
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    match path {
        "/name" => return name(stream, query, places),
        "/places" => return search(stream, query, places),
        "/street" => return street(stream, query, places),
        _ => {}
    }
    let leg = match path {
        "/brouter" => false,
        "/leg" => true,
        _ => return send(stream, "404 Not Found", ""),
    };
    let file_name = match get_url_params(&format!("/brouter?{query}")) {
        Ok(params) if params.contains_key("lonlats") && params.contains_key("profile") => file_name(&params),
        Ok(_) => return send(stream, "404 Not Found", ""),
        Err(exception) => return internal_error(stream, exception),
    };
    // Java's watchdog stops the oldest search once every thread is busy; here a search stops as soon as
    // its client goes away, as the requests the planner abandons do
    let terminated = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = mpsc::channel();
    let reply = move |outcome, _| sender.send(outcome).unwrap_or_default();
    pool.submit(query.to_string(), max_running_time, Some(terminated.clone()), reply);
    let outcome: Outcome = loop {
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(outcome) => break outcome,
            Err(RecvTimeoutError::Timeout) if !client_gone(&stream) => {}
            // gone, or dropped by the pool after that
            Err(_) => return terminated.store(true, Relaxed),
        }
    };
    match outcome {
        Ok(Ok(Answer::GeoJson(geojson))) if leg => match leg_json(&geojson) {
            Ok(json) => send_body(stream, "200 OK", "application/json; charset=utf-8", "", json.as_bytes()),
            Err(reason) => internal_error(stream, reason),
        },
        outcome => answer(stream, outcome, file_name),
    }
}

/// The JSON for a request on the route's legs (`/profile`, `/surfaces`), 400 for a body that is no list of legs.
fn send_json(stream: TcpStream, json: Result<String, String>) {
    match json {
        Ok(json) => send_body(stream, "200 OK", "application/json; charset=utf-8", "", json.as_bytes()),
        Err(reason) => send(stream, "400 Bad Request", &format!("{reason}\n")),
    }
}

/// A parameter's value as the request sent it, percent-encoded.
fn parameter<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| pair.strip_prefix(key)?.strip_prefix('='))
}

fn coordinate(query: &str) -> Option<[f64; 2]> {
    let number = |key: &str| parameter(query, key)?.parse::<f64>().ok().filter(|n| n.is_finite());
    Some([number("lon")?, number("lat")?])
}

/// `GET /places?q=…[&lat=…&lon=…]`: the planner's suggestions (`richi_planner::places_json`), near the map's centre first.
fn search(stream: TcpStream, query: &str, places: Option<&Places>) {
    let q = parameter(query, "q").unwrap_or_default();
    let body =
        places.filter(|_| !q.is_empty()).map_or_else(|| "[]".to_string(), |places| places.search(q, coordinate(query)));
    send_body(stream, "200 OK", "application/json; charset=utf-8", "", body.as_bytes());
}

/// `GET /street?lat=…&lon=…&name=…`: where an address meets its own street, as `{"point":[lon,lat]}`, null where the
/// street is not within reach.
fn street(stream: TcpStream, query: &str, places: Option<&Places>) {
    let (Some(at), Some(name)) = (coordinate(query), parameter(query, "name").and_then(decode)) else {
        return send(stream, "400 Bad Request", "lat, lon and name\n");
    };
    let mut body = String::from("{\"point\":");
    match places.and_then(|places| places.on_street(at, &name)) {
        Some([lon, lat]) => {
            body.push('[');
            push_number(&mut body, lon);
            body.push(',');
            push_number(&mut body, lat);
            body.push(']');
        }
        None => body.push_str("null"),
    }
    body.push('}');
    send_body(stream, "200 OK", "application/json; charset=utf-8", "", body.as_bytes());
}

/// A query value with `+` as a space and its `%XX` escapes read as UTF-8.
fn decode(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut rest = value.bytes();
    while let Some(byte) = rest.next() {
        bytes.push(match byte {
            b'+' => b' ',
            b'%' => u8::from_str_radix(std::str::from_utf8(&[rest.next()?, rest.next()?]).ok()?, 16).ok()?,
            byte => byte,
        });
    }
    String::from_utf8(bytes).ok()
}

/// `GET /name?lat=…&lon=…`: the planner's name for a point, as `{"name":…}`, null where no area knows one.
fn name(stream: TcpStream, query: &str, places: Option<&Places>) {
    let Some([lon, lat]) = coordinate(query) else {
        return send(stream, "400 Bad Request", "lat and lon\n");
    };
    let mut body = String::from("{\"name\":");
    match places.and_then(|places| places.name([lon, lat])) {
        Some(name) => push_string(&mut body, &name),
        None => body.push_str("null"),
    }
    body.push('}');
    send_body(stream, "200 OK", "application/json; charset=utf-8", "", body.as_bytes());
}

/// The answer to a routing request's `outcome`, with the file name for a route.
fn answer(stream: TcpStream, outcome: Outcome, file_name: Option<String>) {
    match outcome {
        Ok(Ok(Answer::GeoJson(geojson))) => {
            let disposition = file_name.map(|name| format!("Content-Disposition: attachment; filename=\"{name}\"\r\n"));
            send_body(
                stream,
                "200 OK",
                "application/vnd.geo+json; charset=utf-8",
                disposition.as_deref().unwrap_or_default(),
                geojson.as_bytes(),
            );
        }
        Ok(Ok(Answer::Error(message))) => send(stream, "400 Bad Request", &format!("{message}\n")),
        Ok(Err(exception)) if exception.class == VERSION_MISMATCH => {
            send(stream, "400 Bad Request", &format!("{}\n", exception.message.unwrap_or_default()));
        }
        Ok(Err(exception)) => internal_error(stream, exception),
        Err(panic) => internal_error(stream, panic_message(&*panic)),
    }
}

/// `POST /loops`.
fn loops(stream: TcpStream, body: &str, pool: &RouterPool, max_running_time: i64) {
    let request = match LoopRequest::parse(body) {
        Ok(request) => request,
        Err(reason) => return send(stream, "400 Bad Request", &format!("{reason}\n")),
    };
    match request.suggest(pool, max_running_time, || client_gone(&stream)) {
        Ok(suggestions) => send_body(
            stream,
            "200 OK",
            "application/json; charset=utf-8",
            "",
            suggestions_json(&suggestions).as_bytes(),
        ),
        Err(Stop::Failed(Failure::Engine(outcome))) => answer(stream, outcome, None),
        Err(Stop::Failed(Failure::Internal(reason))) => internal_error(stream, reason),
        Err(Stop::Aborted) => {}
    }
}

/// `POST /fit`.
fn fit(stream: TcpStream, body: &str) {
    match course_fits(body, SystemTime::now()) {
        Ok(parts) => send_body(stream, "200 OK", "application/json", "", parts.as_bytes()),
        Err(reason) => send(stream, "400 Bad Request", &format!("{reason}\n")),
    }
}

/// Whether the client has closed its end. The request is read in full, so anything to read is its end.
fn client_gone(stream: &TcpStream) -> bool {
    let _ = stream.set_nonblocking(true);
    let gone = match stream.peek(&mut [0; 1]) {
        Ok(read) => read == 0,
        Err(e) => e.kind() != ErrorKind::WouldBlock,
    };
    let _ = stream.set_nonblocking(false);
    gone
}

/// `RouteServer`'s answer to any other exception.
fn internal_error(stream: TcpStream, reason: impl std::fmt::Display) {
    eprintln!("RouteServer got exception (will continue): {reason}");
    send(stream, "500 Internal Server Error", "");
}

/// `ServerHandler.getFileName`: `<trackname or "brouter">.<format>` (the body is GeoJSON whatever
/// `format` asks for). Unlike Java, `format` is filtered too: it must not end the header line.
fn file_name(params: &UrlParams) -> Option<String> {
    let only = |name: &str, extra: &str| {
        name.chars().filter(|c| c.is_ascii_alphanumeric() || extra.contains(*c)).collect::<String>()
    };
    let format = only(params.get("format")?, "");
    Some(format!("{}.{format}", params.get("trackname").map_or_else(|| "brouter".into(), |name| only(name, " ._-"))))
}

fn send(stream: TcpStream, status: &str, text: &str) {
    send_body(stream, status, "text/plain; charset=utf-8", "", text.as_bytes());
}

/// `writeHttpHeader` with the extra `headers`, then the body; the connection closes with the stream.
fn send_body(mut stream: TcpStream, status: &str, content_type: &str, headers: &str, body: &[u8]) {
    let head = format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: {content_type}\r\n{headers}\r\n");
    // a client that went away needs no answer
    let _ = stream.write_all(head.as_bytes()).and_then(|()| stream.write_all(body));
}

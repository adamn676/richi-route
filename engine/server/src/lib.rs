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
//! `GET /name?lat=…&lon=…` names a point as the planner does (`richi_planner::place_name`), from the address search of
//! the offline areas (`Places`, the iPhone app's), `{"name":null}` without them.
//!
//! `POST /loops` with a JSON body (`richi_planner::LoopRequest`, `Content-Type: application/json`)
//! answers the planner's loop suggestions as JSON (`richi_planner::suggestions_json`); where no
//! direction has a loop, the first direction's failure as `/brouter` would answer it, 400 for a
//! malformed request, 405 and 415 for another method or content type.
//!
//! `POST /fit` with a route as JSON, under the same rules, answers its FIT courses, every part of a long
//! one, as JSON with the files in base64 (`richi_planner::course_fits`).

use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime};

use brouter_router::{Answer, Outcome, RouterPool, UrlParams, VERSION_MISMATCH, get_url_params, panic_message};
use richi_planner::{Failure, LoopRequest, Stop, course_fits, leg_json, place_name, push_string, suggestions_json};
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
    areas: OnceLock<Vec<(Index, TypoIndex)>>,
}

impl Places {
    pub fn new(folder: PathBuf) -> Places {
        Places { folder, areas: OnceLock::new() }
    }

    fn areas(&self) -> &[(Index, TypoIndex)] {
        self.areas.get_or_init(|| {
            let files = std::fs::read_dir(&self.folder)
                .into_iter()
                .flatten()
                .flatten()
                .map(|area| area.path().join("search.index"));
            let indexes = files
                .filter_map(|file| std::fs::File::open(file).ok().and_then(|f| Index::read(BufReader::new(f)).ok()));
            indexes
                .map(|index| {
                    let typos = TypoIndex::new(&index);
                    (index, typos)
                })
                .collect()
        })
    }

    /// The planner's name for a point set on the map (`place_name`), from the first area that knows one.
    pub fn name(&self, at: [f64; 2]) -> Option<String> {
        let query = format!("lat={}&lon={}&lang=de&limit=1&radius=0.3", at[1], at[0]);
        self.areas().iter().find_map(|(index, typos)| match photon::answer(index, typos, "/reverse", &query) {
            photon::Answer::Json(json) => place_name(&json, at),
            _ => None,
        })
    }
}

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
    if target == "/loops" || target == "/fit" {
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
        return if target == "/fit" { fit(stream, &body) } else { loops(stream, &body, pool, max_running_time) };
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path == "/name" {
        return name(stream, query, places);
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

/// `GET /name?lat=…&lon=…`: the planner's name for a point, as `{"name":…}`, null where no area knows one.
fn name(stream: TcpStream, query: &str, places: Option<&Places>) {
    let number = |key: &str| {
        query
            .split('&')
            .find_map(|pair| pair.strip_prefix(key)?.strip_prefix('=')?.parse::<f64>().ok())
            .filter(|n| n.is_finite())
    };
    let (Some(lat), Some(lon)) = (number("lat"), number("lon")) else {
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

//! The planner's routing server, as `LocalRulesServer` (BRouter's `RouteServer` with the local rules)
//! answers: one request per connection, `GET /brouter?<query>`. 200 with the GeoJSON, 400 with the
//! routing error or the rules version mismatch, 500 for any other exception, 404 without `lonlats` and
//! `profile`. Unlike Java it queues requests beyond the pool's threads instead of stopping the oldest (a
//! search stops instead when its client goes away), never compresses, and answers GeoJSON whatever
//! `format` asks for (`trackname` names only the file). It sends no `Access-Control-Allow-Origin`: the
//! planner reaches it through its own server, so other web pages cannot read its answers.

use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use brouter_router::{Answer, Outcome, RouterPool, UrlParams, VERSION_MISMATCH, get_url_params, panic_message};

/// BRouter's server default (`maxRunningTime`), for engine mode 0.
pub const MAX_RUNNING_TIME_MS: i64 = 60_000;

/// Answers the connections to `listener`, each search ending after `max_running_time` ms.
pub fn serve(listener: &TcpListener, pool: RouterPool, max_running_time: i64) -> ! {
    let pool = Arc::new(pool);
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let pool = pool.clone();
                std::thread::spawn(move || respond(stream, &pool, max_running_time));
            }
            // out of file handles, or a socket the system took back: try again shortly instead of spinning
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    unreachable!("the listener accepts connections forever");
}

/// `RouteServer.run` for one connection.
fn respond(stream: TcpStream, pool: &RouterPool, max_running_time: i64) {
    // a client that stops sending before the headers end is dropped
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut lines = BufReader::new(&stream).lines();
    let request = lines.next().and_then(Result::ok);
    if !lines.by_ref().map_while(Result::ok).any(|line| line.is_empty()) {
        return send(stream, "400 Bad Request", "");
    }
    let target = request.as_deref().and_then(|r| r.split(' ').nth(1)).unwrap_or_default();
    let query = target.split_once('?').map_or("", |(_, query)| query).to_string();
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
    pool.submit(query, max_running_time, Some(terminated.clone()), reply);
    let outcome: Outcome = loop {
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(outcome) => break outcome,
            Err(RecvTimeoutError::Timeout) if !client_gone(&stream) => {}
            // gone, or dropped by the pool after that
            Err(_) => return terminated.store(true, Relaxed),
        }
    };
    match outcome {
        Ok(Ok(Answer::GeoJson(geojson))) => {
            let disposition = file_name.map(|name| format!("Content-Disposition: attachment; filename=\"{name}\"\r\n"));
            send_body(
                stream,
                "200 OK",
                "application/vnd.geo+json",
                disposition.as_deref().unwrap_or_default(),
                &geojson,
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
    send_body(stream, status, "text/plain", "", text);
}

/// `writeHttpHeader` with the extra `headers`, then the body; the connection closes with the stream.
fn send_body(mut stream: TcpStream, status: &str, mime_type: &str, headers: &str, body: &str) {
    let head =
        format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: {mime_type}; charset=utf-8\r\n{headers}\r\n");
    // a client that went away needs no answer
    let _ = stream.write_all(head.as_bytes()).and_then(|()| stream.write_all(body.as_bytes()));
}

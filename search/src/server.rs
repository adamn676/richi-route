//! The address search over HTTP for the planner (`photon::answer`): one request per connection, on a thread of its own.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use richi_search::index::Index;
use richi_search::photon::{Answer, answer};
use richi_search::search::TypoIndex;

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
    match answer(&service.index, &service.typos, path, query) {
        Answer::Json(body) => send(&mut stream, "200 OK", "application/json; charset=utf-8", &body),
        Answer::BadRequest(reason) => send(&mut stream, "400 Bad Request", "text/plain", &format!("{reason}\n")),
        Answer::NotFound => send(&mut stream, "404 Not Found", "text/plain", ""),
    }
}

/// The answer in one write: header and body in two would wait for the client's acknowledgement in between.
fn send(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let answer = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(answer.as_bytes());
}

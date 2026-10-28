//! `richi-engine lines <segmentDir> <profileDir> <threads>`: answers BRouter requests the way
//! BRouter's server does, without a socket (the protocol of `parity/java/router/RouteReference.java`).
//!
//! Input: one request per line, `id<TAB>query`, with the query string the planner sends to `/brouter`.
//! Output: one JSON line per request, `{"id":…,"ms":…,"error":…}` or `{"id":…,"ms":…,"geojson":…}`,
//! in completion order. Requests run on a pool of `<threads>` workers; the program exits when stdin is
//! closed and every request is answered.

use std::io::{BufRead, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use brouter_router::{Answer, Router, panic_message};

/// BRouter's server default (`maxRunningTime`), for engine mode 0.
const MAX_RUNNING_TIME_MS: i64 = 60_000;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 || args[1] != "lines" {
        eprintln!("usage: richi-engine lines <segmentDir> <profileDir> [threads]");
        std::process::exit(2);
    }
    let segment_dir = PathBuf::from(&args[2]);
    let profile_dir = PathBuf::from(&args[3]);
    let threads = match args.get(4).map(|t| t.parse::<usize>()) {
        None => 1,
        Some(Ok(n)) if n > 0 => n,
        Some(_) => {
            eprintln!("threads must be a positive number");
            std::process::exit(2);
        }
    };

    let (sender, receiver) = mpsc::channel::<(String, String)>();
    let receiver = Arc::new(Mutex::new(receiver));
    let workers: Vec<_> = (0..threads)
        .map(|_| {
            let receiver = Arc::clone(&receiver);
            let (segment_dir, profile_dir) = (segment_dir.clone(), profile_dir.clone());
            std::thread::spawn(move || {
                let mut router = Router::new(segment_dir, profile_dir);
                loop {
                    let job = receiver.lock().expect("job queue").recv();
                    let Ok((id, query)) = job else { break };
                    let result = answer(&mut router, &query);
                    let mut out = std::io::stdout().lock();
                    // a closed stdout leaves nobody to answer
                    if writeln!(out, "{{\"id\":{},{result}}}", quote(&id)).and_then(|()| out.flush()).is_err() {
                        std::process::exit(1);
                    }
                }
            })
        })
        .collect();

    // like Java's UTF-8 reader, malformed bytes become U+FFFD instead of ending the input
    for line in std::io::stdin().lock().split(b'\n') {
        let Ok(line) = line else { break };
        let line = String::from_utf8_lossy(line.strip_suffix(b"\r").unwrap_or(&line));
        if line.is_empty() {
            continue;
        }
        let Some((id, query)) = line.split_once('\t') else {
            eprintln!("ignoring a line without a tab: {line}");
            continue;
        };
        sender.send((id.to_string(), query.to_string())).expect("workers are running");
    }
    drop(sender);
    for worker in workers {
        worker.join().expect("worker thread");
    }
}

/// `RouteReference.answer`: the JSON members after `"id"`.
fn answer(router: &mut Router, query: &str) -> String {
    let start = Instant::now();
    // the engine turns the data layer's internal errors into error answers itself; this catches the rest
    let result = catch_unwind(AssertUnwindSafe(|| router.answer(query, MAX_RUNNING_TIME_MS)));
    let ms = start.elapsed().as_millis();
    let (member, text) = match result {
        Ok(Ok(Answer::GeoJson(geojson))) => ("geojson", geojson),
        Ok(Ok(Answer::Error(message))) => ("error", message),
        Ok(Err(exception)) => ("error", format!("exception: {exception}")),
        Err(panic) => ("error", panic_message(&*panic)),
    };
    format!("\"ms\":{ms},\"{member}\":{}", quote(&text))
}

/// `RouteReference.quote`: a JSON string literal.
fn quote(s: &str) -> String {
    let mut sb = String::with_capacity(s.len() + 16);
    sb.push('"');
    for c in s.chars() {
        match c {
            '"' => sb.push_str("\\\""),
            '\\' => sb.push_str("\\\\"),
            '\n' => sb.push_str("\\n"),
            '\r' => sb.push_str("\\r"),
            '\t' => sb.push_str("\\t"),
            c if (c as u32) < 0x20 => sb.push_str(&format!("\\u{:04x}", c as u32)),
            c => sb.push(c),
        }
    }
    sb.push('"');
    sb
}

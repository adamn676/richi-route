//! `richi-engine lines <segmentDir> <profileDir> [threads] [cellCacheMB]`: answers BRouter requests the
//! way BRouter's server does, without a socket (the protocol of `parity/java/router/RouteReference.java`).
//!
//! Input: one request per line, `id<TAB>query`, with the query string the planner sends to `/brouter`.
//! Output: one JSON line per request, `{"id":…,"ms":…,"error":…}` or `{"id":…,"ms":…,"geojson":…}`,
//! in completion order. Requests run on a pool of `<threads>` threads (default 1), which also run the
//! searches of one request side by side; the program exits when stdin is closed and every request is
//! answered. The threads share the decoded map cells, up to `<cellCacheMB>` megabytes (default
//! `SegmentStore::DEFAULT_CELL_CACHE_BYTES`, 0 to decode every cell for every search as BRouter does).
//!
//! `richi-engine serve <segmentDir> <profileDir> <port> [threads] [bindAddress]`: the planner's routing
//! server (`richi_server`), listening on 127.0.0.1 unless `<bindAddress>` says otherwise.
//!
//! The local rules come from the prepared rule file named by `RICHIROUTE_RULES` (Java:
//! `-Drichiroute.rules`); `serve` needs them, `lines` without them routes as BRouter does. The rider's
//! surface corrections come from the prepared file named by `RICHIROUTE_SURFACES`, read again whenever
//! it changes (BRouter has none). The rider's road preferences come from the prepared file named by
//! `RICHIROUTE_PREFERENCES` (`Preferences`), read once.
//!
//! A search that runs away ends with BRouter's memory error at its own budget, 3 GB unless
//! `RICHIROUTE_SEARCH_MB` says otherwise (`limit_search_memory`); behind that, the heap
//! has a ceiling (`HEAP_CEILING`), so that a fault elsewhere ends the program, not the machine.

use std::alloc::{GlobalAlloc, Layout, System};
use std::io::{BufRead, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};

use brouter_router::{
    Answer, LocalRules, Outcome, Preferences, Rider, RouterPool, SegmentStore, SurfaceFile, limit_search_memory,
    panic_message,
};
use richi_server::{MAX_RUNNING_TIME_MS, serve};

/// About five times what the planner's loop suggestions take with 12 threads.
const HEAP_CEILING: usize = 8 << 30;

/// The system allocator, refusing allocations beyond `HEAP_CEILING`.
struct Ceiling;

#[global_allocator]
static HEAP: Ceiling = Ceiling;
static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
static REPORTED: AtomicBool = AtomicBool::new(false);

impl Ceiling {
    fn grow(size: usize, alloc: impl FnOnce() -> *mut u8) -> *mut u8 {
        if ALLOCATED.fetch_add(size, Relaxed) + size > HEAP_CEILING {
            ALLOCATED.fetch_sub(size, Relaxed);
            // once (the write may allocate); the program aborts right after with "memory allocation
            // of … bytes failed"
            if !REPORTED.swap(true, Relaxed) {
                let _ = std::io::stderr().write_all(b"richi-engine: heap ceiling reached\n");
            }
            return std::ptr::null_mut();
        }
        let ptr = alloc();
        if ptr.is_null() {
            ALLOCATED.fetch_sub(size, Relaxed);
        }
        ptr
    }
}

unsafe impl GlobalAlloc for Ceiling {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        Self::grow(layout.size(), || unsafe { System.alloc(layout) })
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        Self::grow(layout.size(), || unsafe { System.alloc_zeroed(layout) })
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        ALLOCATED.fetch_sub(layout.size(), Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if new_size <= layout.size() {
            let new = unsafe { System.realloc(ptr, layout, new_size) };
            if !new.is_null() {
                ALLOCATED.fetch_sub(layout.size() - new_size, Relaxed);
            }
            return new;
        }
        Self::grow(new_size - layout.size(), || unsafe { System.realloc(ptr, layout, new_size) })
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let serving = match args.get(1).map(String::as_str) {
        Some("lines") if args.len() >= 4 => false,
        Some("serve") if args.len() >= 5 => true,
        _ => fail(
            "usage: richi-engine lines <segmentDir> <profileDir> [threads] [cellCacheMB]\n       \
             richi-engine serve <segmentDir> <profileDir> <port> [threads] [bindAddress]",
        ),
    };
    let profile_dir = PathBuf::from(&args[3]);
    let number = |i: usize, default: usize, min: usize, name: &str| match args.get(i).map(|a| a.parse::<usize>()) {
        None => default,
        Some(Ok(n)) if n >= min => n,
        Some(_) => fail(&format!("{name} must be a number of at least {min}")),
    };
    if let Some(mb) = std::env::var_os("RICHIROUTE_SEARCH_MB") {
        let mb = mb.to_str().and_then(|mb| mb.parse::<usize>().ok());
        limit_search_memory(mb.unwrap_or_else(|| fail("RICHIROUTE_SEARCH_MB must be a number")) << 20);
    }
    let local_rules = std::env::var_os("RICHIROUTE_RULES")
        .map(|file| Arc::new(LocalRules::load(Path::new(&file)).unwrap_or_else(|e| fail(&e))));
    let rider = Rider {
        surfaces: std::env::var_os("RICHIROUTE_SURFACES")
            .map(|file| Arc::new(SurfaceFile::open(Path::new(&file)).unwrap_or_else(|e| fail(&e)))),
        preferences: std::env::var_os("RICHIROUTE_PREFERENCES")
            .map(|file| Arc::new(Preferences::load(Path::new(&file)).unwrap_or_else(|e| fail(&e)))),
    };

    if serving {
        let Some(rules) = local_rules else { fail("serve: set RICHIROUTE_RULES to the prepared rule file") };
        println!("Local routing rules: {}", rules.revision());
        if let Some(surfaces) = &rider.surfaces {
            println!("Surface corrections: {}", surfaces.current().len());
        }
        if let Some(preferences) = &rider.preferences {
            println!("Road preferences: {}", preferences.len());
        }
        let port = args[4].parse::<u16>().unwrap_or_else(|_| fail("port must be a number from 0 to 65535"));
        let address = args.get(6).map_or("127.0.0.1", String::as_str);
        let listener = TcpListener::bind((address, port)).unwrap_or_else(|e| fail(&format!("{address}:{port}: {e}")));
        let segments = Arc::new(SegmentStore::new(&args[2], SegmentStore::DEFAULT_CELL_CACHE_BYTES));
        serve(
            &listener,
            RouterPool::new(segments, profile_dir, number(5, 1, 1, "threads"), Some(rules), rider),
            MAX_RUNNING_TIME_MS,
        );
    }

    let threads = number(4, 1, 1, "threads");
    let cell_cache_bytes = number(5, SegmentStore::DEFAULT_CELL_CACHE_BYTES >> 20, 0, "cellCacheMB") << 20;
    let segments = Arc::new(SegmentStore::new(&args[2], cell_cache_bytes));
    let pool = RouterPool::new(segments, profile_dir, threads, local_rules, rider);

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
        let id = quote(id);
        pool.submit(query.to_string(), MAX_RUNNING_TIME_MS, None, move |outcome, time| {
            let result = answer(outcome, time.as_millis());
            let mut out = std::io::stdout().lock();
            // a closed stdout leaves nobody to answer
            if writeln!(out, "{{\"id\":{id},{result}}}").and_then(|()| out.flush()).is_err() {
                std::process::exit(1);
            }
        });
    }
    pool.finish();
}

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(2);
}

/// `RouteReference.answer`: the JSON members after `"id"`. The engine turns the data layer's internal
/// errors into error answers itself; a panic here is any other one.
fn answer(outcome: Outcome, ms: u128) -> String {
    let (member, text) = match outcome {
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

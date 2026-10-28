//! `richi-engine lines <segmentDir> <profileDir> [threads] [cellCacheMB]`: answers BRouter requests the
//! way BRouter's server does, without a socket (the protocol of `parity/java/router/RouteReference.java`).
//!
//! Input: one request per line, `id<TAB>query`, with the query string the planner sends to `/brouter`.
//! Output: one JSON line per request, `{"id":…,"ms":…,"error":…}` or `{"id":…,"ms":…,"geojson":…}`,
//! in completion order. Requests run on a pool of `<threads>` threads (default 1), which also run the
//! searches of one request side by side; the program exits when stdin is closed and every request is
//! answered. The threads share the decoded map cells, up to `<cellCacheMB>` megabytes (default
//! `SegmentStore::DEFAULT_CELL_CACHE_BYTES`, 0 to decode every cell for every search as BRouter does).
//! Like the Java reference's `-Xmx`, the heap has a ceiling (`HEAP_CEILING`): a search that runs away
//! ends the program, not the machine.

use std::alloc::{GlobalAlloc, Layout, System};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};

use brouter_router::{Answer, Outcome, RouterPool, SegmentStore, panic_message};

/// BRouter's server default (`maxRunningTime`), for engine mode 0.
const MAX_RUNNING_TIME_MS: i64 = 60_000;

/// About four times what the planner's loop suggestions take with 6 threads.
const HEAP_CEILING: usize = 4 << 30;

/// The system allocator, refusing allocations beyond `HEAP_CEILING`.
struct Ceiling;

#[global_allocator]
static HEAP: Ceiling = Ceiling;
static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
static REPORTED: AtomicBool = AtomicBool::new(false);

impl Ceiling {
    /// Counts `size` more bytes and allocates them with `alloc`, if that stays below the ceiling.
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
    if args.len() < 4 || args[1] != "lines" {
        eprintln!("usage: richi-engine lines <segmentDir> <profileDir> [threads] [cellCacheMB]");
        std::process::exit(2);
    }
    let profile_dir = PathBuf::from(&args[3]);
    let number = |i: usize, default: usize, min: usize, name: &str| match args.get(i).map(|a| a.parse::<usize>()) {
        None => default,
        Some(Ok(n)) if n >= min => n,
        Some(_) => {
            eprintln!("{name} must be a number of at least {min}");
            std::process::exit(2);
        }
    };
    let threads = number(4, 1, 1, "threads");
    let cell_cache_bytes = number(5, SegmentStore::DEFAULT_CELL_CACHE_BYTES >> 20, 0, "cellCacheMB") << 20;
    let segments = Arc::new(SegmentStore::new(&args[2], cell_cache_bytes));
    let pool = RouterPool::new(segments, profile_dir, threads);

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
        pool.submit(query.to_string(), MAX_RUNNING_TIME_MS, move |outcome, time| {
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

//! The routing engine inside the iPhone app: the planner's routing server (`richi_server`) on
//! 127.0.0.1, with the routing data in the app bundle's `Routing` folder: `segments/`, `profiles/`,
//! `rules.tsv`, and optionally `surfaces.tsv` and `preferences.tsv`. The app asks it as the planner
//! asks the server on the computer.

use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;

use brouter_router::{LocalRules, Preferences, Rider, RouterPool, SegmentStore, SurfaceFile, limit_search_memory};

/// Starts the server with `threads` searches at a time, each up to `search_mb` megabytes, on a free port
/// and returns the port, or 0 when the data is missing or unreadable (the reason goes to the log). The
/// only function the app calls; it takes and returns plain numbers, so nothing the app hands over needs
/// trusting.
#[unsafe(no_mangle)]
pub extern "C" fn richi_engine_start(threads: u8, search_mb: u32) -> u16 {
    let bundle = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join("Routing")));
    let started = bundle.ok_or_else(|| "no app bundle".to_string()).and_then(|data| start(&data, threads, search_mb));
    started.unwrap_or_else(|reason| {
        eprintln!("richi-engine: {reason}");
        0
    })
}

/// The server over the routing data in `data`, on a free port of 127.0.0.1.
pub fn start(data: &Path, threads: u8, search_mb: u32) -> Result<u16, String> {
    let optional = |name: &str| Some(data.join(name)).filter(|file| file.exists());
    let rules = Arc::new(LocalRules::load(&data.join("rules.tsv"))?);
    let rider = Rider {
        surfaces: optional("surfaces.tsv").map(|file| SurfaceFile::open(&file).map(Arc::new)).transpose()?,
        preferences: optional("preferences.tsv").map(|file| Preferences::load(&file).map(Arc::new)).transpose()?,
    };
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let segments = Arc::new(SegmentStore::new(data.join("segments"), SegmentStore::DEFAULT_CELL_CACHE_BYTES));
    limit_search_memory(search_mb as usize * (1 << 20));
    let pool = RouterPool::new(segments, data.join("profiles"), usize::from(threads.max(1)), Some(rules), rider);
    std::thread::spawn(move || richi_server::serve(&listener, pool));
    Ok(port)
}

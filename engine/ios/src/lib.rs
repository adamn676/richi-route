//! The routing engine inside the iPhone app: the planner's routing server (`richi_server`) on
//! 127.0.0.1. The app bundle's `Routing` folder brings what belongs to a version of the app: `profiles/`,
//! `rules.tsv`, and optionally `surfaces.tsv` and `preferences.tsv`; the routing data, `segments/*.rd5`, and the
//! offline areas, `Areas/<area>/search.index` for naming points, lie in the app's own
//! `Library/Application Support/RichiRoute`, where they stay from one install to the next. The app asks it as the
//! planner asks the server on the computer.

use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;

use brouter_router::{LocalRules, Preferences, Rider, RouterPool, SegmentStore, SurfaceFile, limit_search_memory};
use richi_server::Places;

/// Starts the server with `threads` searches at a time, each up to `search_mb` megabytes, on a free port
/// and returns the port, or 0 when the data is missing or unreadable (the reason goes to the log). The
/// only function the app calls; it takes and returns plain numbers, so nothing the app hands over needs
/// trusting.
#[unsafe(no_mangle)]
pub extern "C" fn richi_engine_start(threads: u8, search_mb: u32) -> u16 {
    let bundle = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join("Routing")));
    // an app's HOME is its own data container; the app reads the same folder (DataFolder in MapStyle.swift)
    let data = std::env::var_os("HOME").map(|home| Path::new(&home).join("Library/Application Support/RichiRoute"));
    let started = bundle
        .zip(data)
        .ok_or_else(|| "no app bundle or data container".to_string())
        .and_then(|(config, data)| start(&config, &data, threads, search_mb));
    started.unwrap_or_else(|reason| {
        eprintln!("richi-engine: {reason}");
        0
    })
}

/// The server with the profiles and rules in `config` over the routing data and areas in `data`, on a free port of
/// 127.0.0.1.
pub fn start(config: &Path, data: &Path, threads: u8, search_mb: u32) -> Result<u16, String> {
    let segments = data.join("segments");
    if !segments.is_dir() {
        return Err(format!("no routing data in {}", segments.display()));
    }
    let optional = |name: &str| Some(config.join(name)).filter(|file| file.exists());
    let rules = Arc::new(LocalRules::load(&config.join("rules.tsv"))?);
    let rider = Rider {
        surfaces: optional("surfaces.tsv").map(|file| SurfaceFile::open(&file).map(Arc::new)).transpose()?,
        preferences: optional("preferences.tsv").map(|file| Preferences::load(&file).map(Arc::new)).transpose()?,
    };
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let segments = Arc::new(SegmentStore::new(&segments, SegmentStore::DEFAULT_CELL_CACHE_BYTES));
    limit_search_memory(search_mb as usize * (1 << 20));
    let pool = RouterPool::new(segments, config.join("profiles"), usize::from(threads.max(1)), Some(rules), rider);
    // a phone takes about three times as long as a computer: long sections get twice BRouter's minute
    let places = Places::new(data.join("Areas"));
    std::thread::spawn(move || {
        richi_server::serve(&listener, pool, Some(places), 2 * richi_server::MAX_RUNNING_TIME_MS)
    });
    Ok(port)
}

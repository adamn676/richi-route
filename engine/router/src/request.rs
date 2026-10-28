//! Answering a `/brouter?<query>` request the way BRouter's server does (`RouteServer` and
//! `ServerHandler`, as `parity/java/router/RouteReference.java` mirrors them).

use std::path::PathBuf;

use crate::engine::{Arenas, RoutingEngine};
use crate::format::format_json;
use crate::java::{self, JavaException};
use crate::param_collector::{get_url_params, get_way_point_list, set_params};
use crate::profile_cache::ProfileCache;
use crate::routing_context::RoutingContext;

/// The answer to a request: the route as GeoJSON, or the routing error with BRouter's text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    GeoJson(String),
    Error(String),
}

/// Answers requests on one thread: keeps its profile cache and search arenas between requests.
pub struct Router {
    segment_dir: PathBuf,
    profiles: ProfileCache,
    arenas: Option<Arenas>,
}

impl Router {
    /// Segments come from `<segment_dir>/*.rd5`, profiles from `<profile_dir>/<name>.brf` with
    /// `<profile_dir>/lookups.dat`.
    pub fn new(segment_dir: impl Into<PathBuf>, profile_dir: impl Into<PathBuf>) -> Self {
        // BRouter shares 2 × threads profile slots among its worker threads; a router keeps 2
        Self {
            segment_dir: segment_dir.into(),
            profiles: ProfileCache::new(profile_dir, 2),
            arenas: Some(Arenas::default()),
        }
    }

    /// `RouteReference.answer`: the server's memory class (128), the profile named by `profile`, the
    /// engine mode from `engineMode`, the track as GeoJSON whatever `format` asks for (BRouter's server
    /// would write GPX, KML or CSV too). `max_running_time` (ms, 0 for none) limits routing (engine mode
    /// 0; round trips run without a limit). `Err` is an exception BRouter throws to its caller, which
    /// the server answers with `exception: <toString()>`.
    pub fn answer(&mut self, query: &str, max_running_time: i64) -> Result<Answer, JavaException> {
        let mut params = get_url_params(&format!("/brouter?{query}"))?;
        let mut rc = RoutingContext::new();
        rc.memoryclass = 128;
        rc.local_function = params.get("profile").map(str::to_string);
        let mut wplist = get_way_point_list(params.get("lonlats"))?;
        params.remove("profile");
        let engine_mode = params.get("engineMode").map_or(Ok(0), java::parse_int)?;
        set_params(&mut rc, &mut wplist, &mut params)?;
        let arenas = self.arenas.take().unwrap_or_default();
        let mut engine =
            RoutingEngine::with_arenas(&self.segment_dir, wplist, rc, engine_mode, &mut self.profiles, arenas)?;
        let run = engine.do_run(max_running_time);
        let answer = match engine.error_message() {
            Some(message) => Answer::Error(message.to_string()),
            None => Answer::GeoJson(format_json(engine.found_track(), engine.elements())),
        };
        // Java releases the profile only when doRun gets to doRouting; that only changes what the
        // cache holds, not results
        self.arenas = Some(engine.finish(&mut self.profiles));
        run?;
        Ok(answer)
    }
}

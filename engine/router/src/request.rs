//! Answering a `/brouter?<query>` request the way BRouter's server does (`RouteServer` and
//! `ServerHandler`, as `parity/java/router/RouteReference.java` mirrors them).

use std::path::PathBuf;
use std::sync::Arc;

use brouter_mapaccess::SegmentStore;

use crate::engine::{self, Arenas, Job, JobResult, RoutingEngine};
use crate::format::format_json;
use crate::java::{self, JavaException};
use crate::local_rules::LocalRules;
use crate::param_collector::{get_url_params, get_way_point_list, set_params};
use crate::pool::Pool;
use crate::profile_cache::ProfileCache;
use crate::routing_context::RoutingContext;

/// The answer to a request: the route as GeoJSON, or the routing error with BRouter's text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    GeoJson(String),
    Error(String),
}

/// Answers requests on one thread: keeps its profile cache and search arenas between requests. Routers
/// on several threads can share one `SegmentStore` (open segment files and decoded cells).
pub struct Router {
    segments: Arc<SegmentStore>,
    profiles: ProfileCache,
    arenas: Arenas,
}

impl Router {
    /// Segments come from `<segment_dir>/*.rd5`, profiles from `<profile_dir>/<name>.brf` with
    /// `<profile_dir>/lookups.dat`. The router gets its own `SegmentStore` with the default cell
    /// budget; routers on several threads, or with a tighter memory budget, use `with_segments`.
    pub fn new(segment_dir: impl Into<PathBuf>, profile_dir: impl Into<PathBuf>) -> Self {
        let segments = SegmentStore::new(segment_dir, SegmentStore::DEFAULT_CELL_CACHE_BYTES);
        Self::with_segments(Arc::new(segments), profile_dir, None)
    }

    /// A router reading its segments through `segments`, with the planner's `local_rules` if given.
    pub fn with_segments(
        segments: Arc<SegmentStore>,
        profile_dir: impl Into<PathBuf>,
        local_rules: Option<Arc<LocalRules>>,
    ) -> Self {
        // BRouter shares 2 × threads profile slots among its worker threads; a router keeps 2
        Self { segments, profiles: ProfileCache::new(profile_dir, 2, local_rules), arenas: Arenas::default() }
    }

    /// `RouteReference.answer`: the server's memory class (128), the profile named by `profile`, the
    /// engine mode from `engineMode`, the track as GeoJSON whatever `format` asks for (BRouter's server
    /// would write GPX, KML or CSV too). `max_running_time` (ms, 0 for none) limits routing (engine mode
    /// 0; round trips run without a limit). `Err` is an exception BRouter throws to its caller, which
    /// the server answers with `exception: <toString()>`.
    pub fn answer(&mut self, query: &str, max_running_time: i64) -> Result<Answer, JavaException> {
        self.answer_in(query, max_running_time, None)
    }

    /// `answer`, with the request's independent searches on the pool's threads.
    pub(crate) fn answer_in(
        &mut self,
        query: &str,
        max_running_time: i64,
        pool: Option<&Pool>,
    ) -> Result<Answer, JavaException> {
        let mut params = get_url_params(&format!("/brouter?{query}"))?;
        let mut rc = RoutingContext::new();
        rc.memoryclass = 128;
        rc.local_function = params.get("profile").map(str::to_string);
        let mut wplist = get_way_point_list(params.get("lonlats"))?;
        params.remove("profile");
        let engine_mode = params.get("engineMode").map_or(Ok(0), java::parse_int)?;
        set_params(&mut rc, &mut wplist, &mut params)?;
        let arenas = std::mem::take(&mut self.arenas);
        let mut engine =
            RoutingEngine::with_arenas(&self.segments, wplist, rc, engine_mode, &mut self.profiles, arenas)?;
        engine.set_pool(pool);
        let run = engine.do_run(max_running_time);
        let answer = match engine.error_message() {
            Some(message) => Answer::Error(message.to_string()),
            None => Answer::GeoJson(format_json(engine.found_track(), engine.elements())),
        };
        // Java releases the profile only when doRun gets to doRouting; that only changes what the
        // cache holds, not results
        self.arenas = engine.finish(&mut self.profiles);
        run?;
        Ok(answer)
    }

    /// Runs another request's search with this router's profile cache and arenas (see
    /// `engine::run_pool_job`).
    pub(crate) fn run_job(&mut self, job: Job) -> Result<JobResult, Box<Job>> {
        engine::run_pool_job(job, &self.segments, &mut self.profiles, &mut self.arenas)
    }
}

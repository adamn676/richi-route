//! Port of `btools.router`: BRouter's routing engine as the planner uses it, routing (engine mode 0)
//! and round trips (engine mode 4) to GeoJSON.
//!
//! # Answering a request
//!
//! [`Router`] answers `/brouter?<query>` requests as BRouter's server does, one router per thread:
//!
//! ```no_run
//! # use brouter_router::{Answer, Router};
//! let mut router = Router::new("segments", "profiles");
//! let query = "profile=richi-local-v1&lonlats=15.4395,47.0707|15.45,47.08&format=geojson";
//! match router.answer(query, 60_000) {
//!     Ok(Answer::GeoJson(geojson)) => println!("{geojson}"),
//!     Ok(Answer::Error(message)) => eprintln!("{message}"), // e.g. "datafile E10_N45.rd5 not found"
//!     Err(exception) => eprintln!("exception: {exception}"), // bad parameters, profile errors
//! }
//! ```
//!
//! Routers on several threads should share the decoded map data: create one `Arc<SegmentStore>`, with a
//! byte budget for decoded cells (`SegmentStore::DEFAULT_CELL_CACHE_BYTES`), and pass it to
//! [`Router::with_segments`]; `Router::new` makes a private one.
//!
//! `Err(JavaException)` stands for the exceptions BRouter throws to its caller; its `Display` is
//! Java's `Throwable.toString()`. Routing failures are `Answer::Error`, with BRouter's texts. Requests
//! that would need code this port leaves out (turn instructions, beeline segments, nogos, pois,
//! kinematic models, ...) fail with a message starting with `not supported by this engine:`. The
//! steps behind `answer` (`get_url_params`, `set_params`, [`RoutingEngine`], `format_json`) are public
//! too.
//!
//! # Java semantics
//!
//! Search order, tie-breaking and arithmetic follow the Java code step by step, including `float`
//! intermediates and integer overflow. `Math.sin`, `Math.cos` and `Math.exp` are HotSpot's intrinsics
//! (`libm`), numbers are printed like `Double.toString`, `Float.toString` and `DecimalFormat` (`java`).

mod engine;
pub mod format;
pub mod java;
mod libm;
mod local_rules;
mod message_data;
mod param_collector;
mod path;
mod path_element;
mod pool;
mod profile_cache;
mod request;
mod routing_context;
mod surfaces;
mod track;

pub use brouter_mapaccess::SegmentStore;
pub use engine::{BROUTER_ENGINEMODE_ROUNDTRIP, BROUTER_ENGINEMODE_ROUTING, RoutingEngine, panic_message};
pub use format::{VERSION, format_json};
pub use java::JavaException;
pub use local_rules::{LocalRules, VERSION_MISMATCH};
pub use message_data::MessageData;
pub use param_collector::{OsmNodeNamed, UrlParams, get_url_params, get_way_point_list, set_params};
pub use path_element::{ElemIdx, OsmPathElement, PathElements};
pub use pool::{Outcome, RouterPool};
pub use profile_cache::ProfileCache;
pub use request::{Answer, Router};
pub use routing_context::RoutingContext;
pub use surfaces::{SurfaceCorrections, SurfaceFile};
pub use track::OsmTrack;

//! Port of `NodesCache`: the per-search view of the segment files, loading cells on demand into the
//! graph of its `OsmNodesMap`.

use crate::direct_weaver::WeaveBuffers;
use crate::files::{OsmFile, PhysicalFile};
use crate::{
    MapError, MatchedWaypoint, NodeIdx, OsmNodePairSet, OsmNodesMap, OsmPos, Pos, SegmentStore, WaypointMatcherImpl,
};
use brouter_codec::{DataBuffers, MicroCache, TagValueValidator, WaypointMatcher};
use std::collections::HashMap;
use std::sync::Arc;

const RETRY_RANGE: f64 = 250.;
/// Used with `RoutingEngine.MAX_DYNAMIC_RANGE = 60000` m.
const MAX_DYNAMIC_CATCHES: i32 = 20;

/// A loaded cell: `file_rows[lat][file]`, cell `sub`.
#[derive(Clone, Copy)]
struct SegmentRef {
    lat: usize,
    file: usize,
    sub: usize,
}

fn segment(file_rows: &mut [Vec<OsmFile>], r: SegmentRef) -> &mut MicroCache {
    file_rows[r.lat][r.file].micro_cache_mut(r.sub).expect("loaded cell")
}

pub struct NodesCache {
    store: Arc<SegmentStore>,

    pub nodes_map: OsmNodesMap,
    lookup_version: i32,

    /// The files this search (and the searches before it in the chain of caches) asked the store for.
    file_cache: HashMap<String, Option<Arc<PhysicalFile>>>,
    data_buffers: DataBuffers,
    weave_buffers: WeaveBuffers,

    /// The open degree squares per latitude degree (Java: `OsmFile[180][]`, where a missing row and an
    /// empty one behave alike).
    file_rows: Vec<Vec<OsmFile>>,

    pub first_file_access_failed: bool,
    pub first_file_access_name: Option<String>,

    cache_sum: i64,
    maxmemtiles: i64,
    detailed: bool,

    garbage_collection_enabled: bool,
    ghost_cleaning_done: bool,

    cache_sum_clean: i64,
    ghost_sum: i64,
    ghost_wakeup: i64,

    /// Java reads `-DdisableDirectWeaving` when the cache is created; set this before loading anything.
    /// Without direct weaving, cells are decoded into `MicroCache2`s and nodes parsed one by one.
    pub direct_weaving: bool,
}

impl NodesCache {
    /// A cache for one search. The previous search's cache, if any, is taken from `old_cache` (Java:
    /// `new NodesCache(..., oldCache, ...)` assigned over the old one) to reuse its open files and
    /// buffers, and, if `detailed` is unchanged, its still-virgin cells (put into ghost state). On error
    /// `old_cache` is left in place, as Java's constructor throws before the assignment.
    ///
    /// `force_secondary_data` and BRouter's secondary segment directory (`storageconfig.txt`) are not
    /// supported: all segments come from the store's directory.
    pub fn new(
        store: &Arc<SegmentStore>,
        ctx_way: &mut dyn TagValueValidator,
        maxmem: i64,
        old_cache: &mut Option<NodesCache>,
        detailed: bool,
    ) -> Result<Self, MapError> {
        ctx_way.set_decode_forbidden(detailed);

        let segment_dir = store.segment_dir();
        if !segment_dir.is_dir() {
            let absolute = std::path::absolute(segment_dir).unwrap_or_else(|_| segment_dir.to_path_buf());
            return Err(MapError::Runtime(format!("segment directory {} does not exist", absolute.display())));
        }

        let mut cache = Self {
            store: store.clone(),
            nodes_map: OsmNodesMap::new(),
            lookup_version: i32::from(ctx_way.lookup_version()),
            file_cache: HashMap::new(),
            data_buffers: DataBuffers::new(),
            weave_buffers: WeaveBuffers::default(),
            file_rows: (0..180).map(|_| Vec::new()).collect(),
            first_file_access_failed: false,
            first_file_access_name: None,
            cache_sum: 0,
            maxmemtiles: maxmem / 8,
            detailed,
            garbage_collection_enabled: false,
            ghost_cleaning_done: false,
            cache_sum_clean: 0,
            ghost_sum: 0,
            ghost_wakeup: 0,
            direct_weaving: true,
        };

        if let Some(old) = old_cache.take() {
            cache.nodes_map = old.nodes_map.recycle(); // Java's garbage collector frees the old graph
            cache.file_cache = old.file_cache;
            cache.data_buffers = old.data_buffers;
            cache.weave_buffers = old.weave_buffers;
            // re-use old, virgin caches (if same detail-mode)
            if old.detailed == detailed {
                cache.file_rows = old.file_rows;
                for osmf in cache.file_rows.iter_mut().flatten() {
                    cache.cache_sum += osmf.set_ghost_state();
                }
            }
        }
        cache.nodes_map.maxmem = (2 * maxmem) / 3;
        cache.ghost_sum = cache.cache_sum;
        Ok(cache)
    }

    pub fn format_status(&self) -> String {
        format!(
            "collecting={} noGhosts={} cacheSum={} cacheSumClean={} ghostSum={} ghostWakeup={}",
            self.garbage_collection_enabled,
            self.ghost_cleaning_done,
            self.cache_sum,
            self.cache_sum_clean,
            self.ghost_sum,
            self.ghost_wakeup
        )
    }

    /// Forgets the open files and loaded cells but keeps the allocations, for the searches of another
    /// request: Java's caches start without files for each request.
    pub fn forget_files(&mut self) {
        self.file_cache.clear();
        self.file_rows.iter_mut().for_each(Vec::clear);
    }

    /// Drops non-virgin cells (or all cells with `all`), so they are decoded again.
    pub fn clean(&mut self, all: bool) {
        for osmf in self.file_rows.iter_mut().flatten() {
            osmf.clean(all);
        }
    }

    /// If the cache sum exceeded a threshold, clean all ghosts and enable garbage collection.
    fn check_enable_cache_cleaning(&mut self) {
        if self.cache_sum < self.maxmemtiles {
            return;
        }

        for osmf in self.file_rows.iter_mut().flatten() {
            if self.garbage_collection_enabled && !self.ghost_cleaning_done {
                osmf.clean_ghosts();
            } else {
                self.cache_sum -= osmf.collect_all();
            }
        }

        if self.garbage_collection_enabled {
            self.ghost_cleaning_done = true;
            self.maxmemtiles *= 2;
        } else {
            self.cache_sum_clean = self.cache_sum;
            self.garbage_collection_enabled = true;
        }
    }

    /// `getSegmentFor`: the cell at this position, loading it if needed; `None` without data. With
    /// direct weaving a loaded cell is an empty marker, its nodes are in `nodes_map`.
    pub fn get_segment_for(
        &mut self,
        ilon: i32,
        ilat: i32,
        ctx_way: &mut dyn TagValueValidator,
    ) -> Result<Option<&mut MicroCache>, MapError> {
        let r = self.segment_for(ilon, ilat, ctx_way, None)?;
        Ok(r.map(|r| segment(&mut self.file_rows, r)))
    }

    /// Finds or opens the degree square, then finds, wakes up or decodes the cell. While matching
    /// waypoints with dynamic range, cells are decoded again on every visit, as in Java.
    fn segment_for(
        &mut self,
        ilon: i32,
        ilat: i32,
        ctx_way: &mut dyn TagValueValidator,
        matcher: Option<&mut WaypointMatcherImpl>,
    ) -> Result<Option<SegmentRef>, MapError> {
        let lon_degree = ilon / 1_000_000;
        let lat_degree = ilat / 1_000_000;
        if !(0..180).contains(&lat_degree) {
            return Err(MapError::Runtime(format!("Index {lat_degree} out of bounds for length 180")));
        }
        let lat = lat_degree as usize;
        let file = match self.file_rows[lat].iter().position(|f| f.lon_degree == lon_degree) {
            Some(i) => i,
            None => {
                let osmf = self.file_for_segment(lon_degree, lat_degree).map_err(MapError::Runtime)?;
                self.file_rows[lat].push(osmf);
                self.file_rows[lat].len() - 1
            }
        };
        let osmf = &mut self.file_rows[lat][file];
        if !osmf.has_data() {
            return Ok(None);
        }

        let sub = osmf.sub_idx(ilon, ilat).map_err(MapError::Runtime)?;
        let r = SegmentRef { lat, file, sub };
        let use_dynamic_range = matcher.as_ref().is_some_and(|m| m.use_dynamic_range);
        // needed for a second chance
        if osmf.micro_cache_mut(r.sub).is_none() || use_dynamic_range {
            self.check_enable_cache_cleaning();
            let hollow_nodes = self.direct_weaving.then_some(&mut self.nodes_map);
            let matcher = matcher.map(|m| m as &mut dyn WaypointMatcher);
            self.file_rows[lat][file]
                .create_micro_cache(
                    ilon,
                    ilat,
                    &self.store,
                    &mut self.data_buffers,
                    &mut self.weave_buffers,
                    ctx_way,
                    matcher,
                    hollow_nodes,
                )
                .map_err(MapError::Runtime)?;
            self.cache_sum += i64::from(segment(&mut self.file_rows, r).get_data_size());
        } else {
            let segment = segment(&mut self.file_rows, r);
            if segment.ghost {
                segment.un_ghost();
                self.ghost_wakeup += i64::from(segment.get_data_size());
            }
        }
        Ok(Some(r))
    }

    /// Makes sure the node is non-hollow, i.e. loaded with its data. Returns false if it is still
    /// hollow (no data at its position).
    pub fn obtain_non_hollow_node(
        &mut self,
        node: NodeIdx,
        ctx_way: &mut dyn TagValueValidator,
    ) -> Result<bool, MapError> {
        if !self.nodes_map.is_hollow(node) {
            return Ok(true);
        }

        let (ilon, ilat) = (self.nodes_map.node(node).ilon, self.nodes_map.node(node).ilat);
        let Some(r) = self.segment_for(ilon, ilat, ctx_way, None)? else {
            return Ok(false);
        };
        if !self.nodes_map.is_hollow(node) {
            return Ok(true); // direct weaving...
        }

        let id = self.nodes_map.id_from_pos(node);
        let segment = segment(&mut self.file_rows, r);
        if let Some(mut body) = segment.get_and_clear(id) {
            self.nodes_map.parse_node_body2(node, &mut body, ctx_way);
        }

        if self.garbage_collection_enabled {
            let size = segment.get_size();
            self.cache_sum -= i64::from(segment.collect(size >> 1)); // threshold = 1/2 of size is deleted
        }

        Ok(!self.nodes_map.is_hollow(node))
    }

    /// Makes sure all link targets of the given node are non-hollow.
    pub fn expand_hollow_link_targets(
        &mut self,
        n: NodeIdx,
        ctx_way: &mut dyn TagValueValidator,
    ) -> Result<(), MapError> {
        let mut l = self.nodes_map.node(n).firstlink;
        while let Some(link) = l {
            let target = self.nodes_map.target(link, n);
            self.obtain_non_hollow_node(target, ctx_way)?;
            l = self.nodes_map.next_link(link, n);
        }
        Ok(())
    }

    /// True if any link target of the given node is hollow.
    pub fn has_hollow_link_targets(&self, n: NodeIdx) -> bool {
        self.nodes_map.has_hollow_link_targets(n)
    }

    /// The node for `id` with all link targets non-hollow, or `None` if not found. No instance of the
    /// node may exist yet, so call this once, right after creating the cache.
    pub fn get_start_node(
        &mut self,
        id: i64,
        ctx_way: &mut dyn TagValueValidator,
    ) -> Result<Option<NodeIdx>, MapError> {
        // initialize the start-node
        let pos = Pos::from_id(id);
        let n = self.nodes_map.create_node(pos.ilon, pos.ilat);
        self.nodes_map.set_hollow(n);
        self.nodes_map.put(n);
        if !self.obtain_non_hollow_node(n, ctx_way)? {
            return Ok(None);
        }
        self.expand_hollow_link_targets(n, ctx_way)?;
        Ok(Some(n))
    }

    /// The graph node at the template's position: the indexed one if there is one, else a new hollow
    /// node, which gets indexed.
    pub fn get_graph_node(&mut self, template: &dyn OsmPos) -> NodeIdx {
        // Java puts a new node and puts the existing one back; looking it up first leaves the same index
        // without a dead node in the arena.
        if let Some(existing) = self.nodes_map.get(template.ilon(), template.ilat()) {
            return existing;
        }
        let graph_node = self.nodes_map.create_node(template.ilon(), template.ilat());
        self.nodes_map.set_hollow(graph_node);
        self.nodes_map.put(graph_node);
        graph_node
    }

    /// Matches each waypoint to the nearest usable way section, filling the waypoints in place. A
    /// negative `max_distance` widens the search up to its absolute value (round-trip mode). Returns
    /// false if a waypoint could not be matched.
    ///
    /// Java's `RoutingEngine` retries with a filtered list whose `MatchedWaypoint`s are the same objects
    /// as in the full list, so the matcher's writes land in both. A caller passing a filtered copy must
    /// write every field back by index, including `direction_to_next`, which the matcher rewrites.
    pub fn match_waypoints_to_nodes(
        &mut self,
        unmatched_waypoints: &mut Vec<MatchedWaypoint>,
        max_distance: f64,
        island_node_pairs: &OsmNodePairSet,
        ctx_way: &mut dyn TagValueValidator,
    ) -> Result<bool, MapError> {
        // Java keeps the matcher in the cache after this call; RoutingEngine always resets the cache
        // before loading anything else, so here it lives only for the call.
        let mut matcher = WaypointMatcherImpl::new(unmatched_waypoints, max_distance, island_node_pairs);
        for i in 0..matcher.waypoints().len() {
            let waypoint = matcher.waypoints()[i].waypoint;
            let mut cellsize = 12_500;
            self.preload_position(waypoint, cellsize, 1, false, ctx_way, &mut matcher)?;
            // get a second chance
            let mwp = &matcher.waypoints()[i];
            if mwp.crosspoint.is_none() || mwp.radius > RETRY_RANGE {
                cellsize = 1_000_000 / 32;
                let maxscale = if max_distance < 0. { MAX_DYNAMIC_CATCHES } else { 2 };
                self.preload_position(waypoint, cellsize, maxscale, max_distance < 0., ctx_way, &mut matcher)?;
            }
        }

        if self.first_file_access_failed {
            return Err(self.datafile_not_found());
        }
        let len = unmatched_waypoints.len();
        for i in 0..len {
            let after_direct =
                len > 1 && i == len - 1 && unmatched_waypoints[i - 1].wpttype == MatchedWaypoint::WAYPOINT_TYPE_DIRECT;
            let mwp = &mut unmatched_waypoints[i];
            if mwp.crosspoint.is_none() && !after_direct {
                // do not break here throw new IllegalArgumentException(mwp.name + "-position not mapped in existing datafile");
                return Ok(false);
            }
            if after_direct {
                mwp.crosspoint = Some(mwp.waypoint);
                mwp.wpttype = MatchedWaypoint::WAYPOINT_TYPE_DIRECT;
            }
        }
        Ok(true)
    }

    fn datafile_not_found(&self) -> MapError {
        let name = self.first_file_access_name.as_deref().unwrap_or("null"); // Java prints null
        MapError::IllegalArgument(format!("datafile {name} not found"))
    }

    fn preload_position(
        &mut self,
        n: Pos,
        d: i32,
        maxscale: i32,
        use_dynamic_range: bool,
        ctx_way: &mut dyn TagValueValidator,
        matcher: &mut WaypointMatcherImpl,
    ) -> Result<(), MapError> {
        self.first_file_access_failed = false;
        self.first_file_access_name = None;
        self.segment_for(n.ilon, n.ilat, ctx_way, Some(&mut *matcher))?;
        if self.first_file_access_failed {
            return Err(self.datafile_not_found());
        }
        let mut scale = 1;
        while scale < maxscale {
            for idx_lat in -scale..=scale {
                for idx_lon in -scale..=scale {
                    if idx_lon != 0 || idx_lat != 0 {
                        let ilon = n.ilon.wrapping_add(d.wrapping_mul(idx_lon));
                        let ilat = n.ilat.wrapping_add(d.wrapping_mul(idx_lat));
                        self.segment_for(ilon, ilat, ctx_way, Some(&mut *matcher))?;
                    }
                }
            }
            if use_dynamic_range && matcher.has_match(n.ilon, n.ilat) {
                break;
            }
            scale += 1;
        }
        Ok(())
    }

    fn file_for_segment(&mut self, lon_degree: i32, lat_degree: i32) -> Result<OsmFile, String> {
        let lon_mod5 = lon_degree % 5;
        let lat_mod5 = lat_degree % 5;

        let lon = lon_degree - 180 - lon_mod5;
        let slon = if lon < 0 { format!("W{}", -lon) } else { format!("E{lon}") };
        let lat = lat_degree - 90 - lat_mod5;
        let slat = if lat < 0 { format!("S{}", -lat) } else { format!("N{lat}") };
        let filename_base = format!("{slon}_{slat}");
        let file_name = format!("{filename_base}.rd5");

        if !self.file_cache.contains_key(&filename_base) {
            let ra = self.store.open_file(&file_name, self.lookup_version)?;
            self.file_cache.insert(filename_base.clone(), ra);
        }
        let ra = self.file_cache[&filename_base].clone();
        let osmf = OsmFile::new(ra.as_ref(), lon_degree, lat_degree)?;

        if self.first_file_access_name.is_none() {
            self.first_file_access_name = Some(file_name);
            self.first_file_access_failed = ra.is_none();
        }

        Ok(osmf)
    }

    /// The elevation source type of the loaded square at this position (3 if unknown). Java throws for a
    /// latitude outside the map; this returns 3 there too.
    pub fn get_elevation_type(&self, ilon: i32, ilat: i32) -> i32 {
        let lon_degree = ilon / 1_000_000;
        let lat_degree = ilat / 1_000_000;
        self.file_rows
            .get(lat_degree as usize)
            .and_then(|row| row.iter().find(|f| f.lon_degree == lon_degree))
            .map_or(3, |f| i32::from(f.elevation_type))
    }

    /// The elevation source types of the squares this cache has opened, for `get_elevation_type`
    /// once the cache is gone.
    pub fn elevation_types(&self) -> ElevationTypes {
        let squares = self.file_rows.iter().enumerate().flat_map(|(lat_degree, row)| {
            row.iter().map(move |f| (f.lon_degree, lat_degree as i32, i32::from(f.elevation_type)))
        });
        ElevationTypes(squares.collect())
    }
}

/// `NodesCache::get_elevation_type` of a cache, kept apart from it: (lon degree, lat degree, type) of
/// each opened square.
#[derive(Clone, Debug, Default)]
pub struct ElevationTypes(Vec<(i32, i32, i32)>);

impl ElevationTypes {
    pub fn get(&self, ilon: i32, ilat: i32) -> i32 {
        let (lon_degree, lat_degree) = (ilon / 1_000_000, ilat / 1_000_000);
        self.0.iter().find(|&&(lon, lat, _)| lon == lon_degree && lat == lat_degree).map_or(3, |&(_, _, t)| t)
    }
}

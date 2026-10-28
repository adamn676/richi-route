//! Rust side of the data-layer parity check: prints the same text as `parity/java/data/DataDump.java`.
//!
//! Usage: `data_parity decode|decode-mc|match [segment-dir lookups.dat] [full]`,
//! `data_parity decode-real [segment-dir profile.brf] [full]`, `data_parity heap|ruler`. Without paths,
//! `RICHIROUTE_SEGMENTS` and `RICHIROUTE_PROFILES` (or the defaults from PORTING.md) are used; see
//! `parity/README.md`. `cargo test` checks the `heap` and `ruler` sections against the Java digests.

use brouter_codec::TagValueValidator;
use brouter_expressions::Profile;
use brouter_mapaccess::{
    GeometryDecoder, LinkIdx, MapError, MatchedWaypoint, NodeIdx, NodesCache, OsmNodePairSet, OsmPos, Pos, SegmentStore,
};
use brouter_util::{ByteArrayUnifier, CheapAngleMeter, Description, SortedHeap, cheap_ruler, crc};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt::Write as _;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

const MAXMEM: i64 = 128 * 1024 * 1024;

/// The segments behind every `NodesCache` of a mode. Its cell cache is small, so cells are woven both
/// from the cache and freshly decoded (Java decodes each time).
fn segment_store(seg_dir: &Path) -> Arc<SegmentStore> {
    Arc::new(SegmentStore::new(seg_dir, 4 << 20))
}

/// `java.util.Random`.
struct JavaRandom {
    seed: i64,
}

impl JavaRandom {
    const MULTIPLIER: i64 = 0x5_DEEC_E66D;
    const MASK: i64 = (1 << 48) - 1;

    fn new(seed: i64) -> Self {
        Self { seed: (seed ^ Self::MULTIPLIER) & Self::MASK }
    }

    fn next(&mut self, bits: u32) -> i32 {
        self.seed = self.seed.wrapping_mul(Self::MULTIPLIER).wrapping_add(0xB) & Self::MASK;
        (self.seed >> (48 - bits)) as i32
    }

    fn next_int(&mut self, bound: i32) -> i32 {
        let mut r = self.next(31);
        let m = bound - 1;
        if bound & m == 0 {
            return ((i64::from(bound) * i64::from(r)) >> 31) as i32;
        }
        let mut u = r;
        loop {
            r = u % bound;
            if u.wrapping_sub(r).wrapping_add(m) >= 0 {
                return r;
            }
            u = self.next(31);
        }
    }
}

/// Mirror of the Java test double `parity/java/data/shadow/btools/expressions/BExpressionContextWay`.
struct TestValidator {
    decode_forbidden: bool,
    interned: HashMap<Vec<u8>, Description>,
    lookup_version: i16,
    lookup_minor_version: i16,
}

impl TestValidator {
    fn new(lookups: &Path) -> Self {
        let text = std::fs::read_to_string(lookups).unwrap_or_else(|e| panic!("{}: {e}", lookups.display()));
        let mut v =
            Self { decode_forbidden: true, interned: HashMap::new(), lookup_version: -1, lookup_minor_version: -1 };
        for line in text.lines() {
            if let Some(x) = line.strip_prefix("---lookupversion:") {
                v.lookup_version = x.trim().parse().expect("lookup version");
            }
            if let Some(x) = line.strip_prefix("---minorversion:") {
                v.lookup_minor_version = x.trim().parse().expect("minor version");
            }
        }
        v
    }
}

impl ByteArrayUnifier for TestValidator {
    fn unify(&mut self, ab: &[u8], offset: usize, len: usize) -> Description {
        let bytes = &ab[offset..offset + len];
        if let Some(known) = self.interned.get(bytes) {
            return known.clone();
        }
        let description: Description = Rc::from(bytes);
        self.interned.insert(bytes.to_vec(), description.clone());
        description
    }
}

impl TagValueValidator for TestValidator {
    fn access_type(&mut self, description: &[u8]) -> i32 {
        let r = (crc(description, 0, description.len()) as u32 >> 4) % 10;
        let access_type = if r < 2 {
            0
        } else if r < 4 {
            1
        } else {
            2
        };
        if access_type == 1 && !self.decode_forbidden { 0 } else { access_type }
    }

    fn is_lookup_idx_used(&self, idx: usize) -> bool {
        idx % 5 != 3
    }

    fn set_decode_forbidden(&mut self, decode_forbidden: bool) {
        self.decode_forbidden = decode_forbidden;
    }

    fn check_start_way(&mut self, ab: &[u8]) -> bool {
        !(crc(ab, 0, ab.len()) as u32 >> 12).is_multiple_of(8)
    }

    fn lookup_version(&self) -> i16 {
        self.lookup_version
    }

    fn lookup_minor_version(&self) -> i16 {
        self.lookup_minor_version
    }
}

/// Section digests: FNV-1a over the canonical text, printed in full only when `detail` is set.
struct Out {
    w: Box<dyn Write>,
    fnv: u64,
    lines: usize,
    detail: bool,
}

impl Out {
    fn new(w: impl Write + 'static) -> Self {
        Self { w: Box::new(w), fnv: 0, lines: 0, detail: false }
    }

    fn begin(&mut self, detail: bool) {
        self.fnv = 0xcbf2_9ce4_8422_2325;
        self.lines = 0;
        self.detail = detail;
    }

    fn line(&mut self, s: &str) {
        if self.detail {
            writeln!(self.w, "{s}").unwrap();
        }
        for &b in s.as_bytes().iter().chain(b"\n") {
            self.fnv ^= u64::from(b);
            self.fnv = self.fnv.wrapping_mul(0x100_0000_01b3);
        }
        self.lines += 1;
    }

    fn end(&mut self, name: &str) {
        writeln!(self.w, "D {name} lines={} fnv={:x}", self.lines, self.fnv).unwrap();
    }

    fn raw(&mut self, s: &str) {
        writeln!(self.w, "{s}").unwrap();
    }
}

fn hex(ab: Option<&[u8]>) -> String {
    match ab {
        None => "-".into(),
        Some(ab) => ab.iter().fold(String::new(), |mut s, b| {
            write!(s, "{b:02x}").unwrap();
            s
        }),
    }
}

fn pos(p: Option<Pos>) -> String {
    p.map_or("-".into(), |p| format!("{},{}", p.ilon, p.ilat))
}

fn bits(d: f64) -> String {
    format!("{:x}", d.to_bits())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or_else(|| {
        eprintln!("usage: data_parity decode|decode-mc|match|heap|ruler [segment-dir lookups.dat] [full]");
        std::process::exit(2);
    });
    let mut out = Out::new(BufWriter::with_capacity(1 << 16, std::io::stdout()));
    match mode {
        "heap" => heap(&mut out),
        "ruler" => ruler(&mut out),
        _ => {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
            let segments = args.get(2).map(PathBuf::from).unwrap_or_else(|| {
                std::env::var_os("RICHIROUTE_SEGMENTS")
                    .map_or_else(|| root.join("../richiroute-ubuntu-benchmark/data"), PathBuf::from)
            });
            let profiles = std::env::var_os("RICHIROUTE_PROFILES")
                .map_or_else(|| root.join("experiments/routing/.local/local-routing-rules/profiles"), PathBuf::from);
            let real = mode == "decode-real";
            let file = if real { "richi-local-v1.brf" } else { "lookups.dat" };
            let file = args.get(3).map_or_else(|| profiles.join(file), PathBuf::from);
            if !segments.join("E10_N45.rd5").exists() || !file.exists() {
                eprintln!("skipping: segments ({}) or {} missing", segments.display(), file.display());
                return;
            }
            let full = args.get(4).is_some_and(|a| a == "full");
            let result = match mode {
                "decode-real" => decode_real(&mut out, &segments, &file, full),
                "decode" => {
                    decode(&mut out, &segments, &mut TestValidator::new(&file), full, false, &decode_positions(false))
                        .map_err(Into::into)
                }
                "decode-mc" => {
                    decode(&mut out, &segments, &mut TestValidator::new(&file), full, true, &decode_positions(true))
                        .map_err(Into::into)
                }
                "match" => {
                    match_waypoints(&mut out, &segments, &mut TestValidator::new(&file), full).map_err(Into::into)
                }
                _ => panic!("unknown mode {mode}"),
            };
            if let Err(e) = result {
                panic!("{e}");
            }
        }
    }
    out.w.flush().unwrap();
}

/// The planner's profile through the same decode dump (Java: `DataDump decode-real`), loaded as
/// `ProfileCache` does.
fn decode_real(
    out: &mut Out,
    seg_dir: &Path,
    profile_file: &Path,
    full: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let lookups = profile_file.with_file_name("lookups.dat");
    let mut profile = Profile::load(&lookups, profile_file, &[], 128 * 512)?;
    if profile.way.variable_value("processUnusedTags", 0.) != 0. {
        profile.way.set_all_tags_used();
    }
    decode(out, seg_dir, &mut profile.way, full, false, &real_positions())?;
    Ok(())
}

// ---------------------------------------------------------------------- positions

fn decode_positions(mc: bool) -> Vec<(i32, i32)> {
    let mut list = Vec::new();
    let mut rnd = JavaRandom::new(if mc { 4242 } else { 1234 });
    let nrandom = if mc { 60 } else { 220 };
    for _ in 0..nrandom {
        let ilon = 190_000_000 + rnd.next_int(10_000_000);
        let ilat = 135_000_000 + rnd.next_int(5_000_000);
        list.push((ilon, ilat));
    }
    let ndense = if mc { 3 } else { 5 };
    for (clon, clat) in [(195_430_000, 137_070_000), (196_370_000, 138_210_000)] {
        for a in 0..ndense {
            for b in 0..ndense {
                list.push((clon + (a - ndense / 2) * 10_000, clat + (b - ndense / 2) * 10_000));
            }
        }
    }
    list
}

/// A handful of positions for the real-profile dump: Graz and Vienna, plus a few random ones.
fn real_positions() -> Vec<(i32, i32)> {
    let mut list = Vec::new();
    for (clon, clat) in [(195_430_000, 137_070_000), (196_370_000, 138_210_000)] {
        for a in -1..=1 {
            list.push((clon + a * 10_000, clat - a * 10_000));
        }
    }
    let mut rnd = JavaRandom::new(31337);
    for _ in 0..6 {
        let ilon = 190_000_000 + rnd.next_int(10_000_000);
        let ilat = 135_000_000 + rnd.next_int(5_000_000);
        list.push((ilon, ilat));
    }
    list
}

// ---------------------------------------------------------------------- graph dump

fn node_pos(nc: &NodesCache, n: NodeIdx) -> String {
    let node = nc.nodes_map.node(n);
    format!("{},{}", node.ilon, node.ilat)
}

fn chain(nc: &NodesCache, n: NodeIdx) -> Vec<LinkIdx> {
    nc.nodes_map.links(n).collect()
}

/// All nodes reachable from the indexed nodes and the seeds, sorted by id (stable).
fn reachable(nc: &NodesCache, seeds: &[NodeIdx]) -> Vec<NodeIdx> {
    let map = &nc.nodes_map;
    let mut seen = HashSet::new();
    let mut order = Vec::new();
    let mut queue = VecDeque::new();
    for n in map.indexed_nodes().chain(seeds.iter().copied()) {
        if seen.insert(n) {
            order.push(n);
            queue.push_back(n);
        }
    }
    while let Some(n) = queue.pop_front() {
        for l in chain(nc, n) {
            let t = map.target(l, n);
            if seen.insert(t) {
                order.push(t);
                queue.push_back(t);
            }
        }
    }
    order.sort_by_key(|&n| map.node(n).id_from_pos());
    order
}

fn node_line(nc: &NodesCache, n: NodeIdx) -> String {
    let map = &nc.nodes_map;
    let node = map.node(n);
    let mut s = format!(
        "N {} e={} v={} h={} d={} t=",
        node_pos(nc, n),
        node.selev,
        node.visit_id,
        u8::from(node.is_hollow()),
        hex(node.node_description.as_deref())
    );
    for tr in map.restrictions(n) {
        write!(
            s,
            "{},{},{},{},{},{};",
            u8::from(tr.is_positive),
            tr.exceptions,
            tr.from_lon,
            tr.from_lat,
            tr.to_lon,
            tr.to_lat
        )
        .unwrap();
    }
    s
}

fn link_line(nc: &NodesCache, n: NodeIdx, l: LinkIdx, gd: &mut GeometryDecoder) -> String {
    let map = &nc.nodes_map;
    let link = map.link(l);
    let t = map.target(l, n);
    let rev = link.is_reverse(n);
    let own = if l == map.node(n).own_link() {
        "S"
    } else if l == map.node(t).own_link() {
        "T"
    } else {
        "-"
    };
    let mut s = format!(
        "  L {} r={} b={} o={own} d={} g={} x=",
        node_pos(nc, t),
        u8::from(rev),
        u8::from(link.is_bidirectional()),
        hex(link.description_bitmap.as_deref()),
        hex(link.geometry.as_deref())
    );
    if let Some(geometry) = &link.geometry {
        for tn in gd.decode_geometry(geometry, map.node(n), map.node(t), rev) {
            write!(s, "{},{},{};", tn.ilon, tn.ilat, tn.selev).unwrap();
        }
    }
    s
}

fn dump_graph(out: &mut Out, tag: &str, nc: &NodesCache, seeds: &[NodeIdx]) {
    let mut gd = GeometryDecoder::new();
    let nodes = reachable(nc, seeds);
    let mut nlinks = 0;
    for &n in &nodes {
        out.line(&node_line(nc, n));
        for l in chain(nc, n) {
            out.line(&link_line(nc, n, l, &mut gd));
            nlinks += 1;
        }
    }
    out.line(&format!("G {tag} nodes={} links={nlinks}", nodes.len()));
}

fn dump_index(out: &mut Out, nc: &NodesCache) {
    let idx: Vec<NodeIdx> = nc.nodes_map.indexed_nodes().collect();
    out.line(&format!("I {}", idx.len()));
    let mut s = String::from("i");
    for (k, &n) in idx.iter().enumerate() {
        write!(s, " {}", node_pos(nc, n)).unwrap();
        if k % 16 == 15 || k == idx.len() - 1 {
            out.line(&s);
            s = String::from("i");
        }
    }
}

/// Mirror of the router's path holders: `next_for_link` per holder.
fn holders(nc: &NodesCache, next: &HashMap<u32, u32>, l: LinkIdx, source: Option<NodeIdx>) -> String {
    let mut s = String::from("[");
    let first = nc.nodes_map.link(l).first_link_holder(source);
    for h in std::iter::successors(first, |h| next.get(h).copied()) {
        write!(s, "{h};").unwrap();
    }
    s.push(']');
    s
}

/// What the router does to links: path holders per direction, one-sided unlinks, a start link.
fn router_ops(out: &mut Out, nc: &mut NodesCache, nodes: &[NodeIdx]) {
    let mut next = HashMap::new();
    let mut holder = 0u32;
    // Java's addLinkHolder, with the router's side of the contract
    let add = |nc: &mut NodesCache, next: &mut HashMap<u32, u32>, l: LinkIdx, h: u32, source: Option<NodeIdx>| {
        if let Some(previous) = nc.nodes_map.link_mut(l).add_link_holder(h, source) {
            next.insert(h, previous);
        }
    };
    for k in 0..8 {
        if nodes.is_empty() {
            break;
        }
        let n = nodes[k * nodes.len() / 8];
        let mut l = nc.nodes_map.node(n).firstlink;
        if let Some(first) = l
            && k % 4 == 3
            && nc.nodes_map.next_link(first, n).is_some()
        {
            l = nc.nodes_map.next_link(first, n);
        }
        let Some(l) = l else { continue };
        let t = nc.nodes_map.target(l, n);
        for _ in 0..1 + k % 3 {
            add(nc, &mut next, l, holder, Some(n));
            holder += 1;
        }
        let bidir = nc.nodes_map.link(l).is_bidirectional(); // else an earlier unlink removed the direction from t
        if bidir {
            add(nc, &mut next, l, holder, Some(t));
            holder += 1;
        }
        let back = if bidir { holders(nc, &next, l, Some(t)) } else { "-".into() };
        out.line(&format!(
            "holders {} {} fwd={} back={back}",
            node_pos(nc, n),
            node_pos(nc, t),
            holders(nc, &next, l, Some(n))
        ));
        if k % 2 == 0 {
            nc.nodes_map.unlink_link(n, l);
            let link = nc.nodes_map.link(l);
            let back = if link.is_link_unused() { "-".into() } else { holders(nc, &next, l, Some(t)) };
            out.line(&format!(
                "unlinked bidir={} unused={} back={back}",
                link.is_bidirectional(),
                link.is_link_unused()
            ));
        }
    }
    if let Some(&first) = nodes.first() {
        let start = nc.nodes_map.create_link(None, Some(first));
        add(nc, &mut next, start, holder, None);
        add(nc, &mut next, start, holder + 1, None);
        let link = nc.nodes_map.link(start);
        let target = link.target(None).expect("start link target");
        out.line(&format!(
            "startlink {} {} rev={} bidir={}",
            node_pos(nc, target),
            holders(nc, &next, start, None),
            link.is_reverse(None),
            link.is_bidirectional()
        ));
    }
}

fn non_hollow(nc: &NodesCache, nodes: &[NodeIdx]) -> Vec<NodeIdx> {
    nodes.iter().copied().filter(|&n| !nc.nodes_map.is_hollow(n)).collect()
}

// ---------------------------------------------------------------------- decode

fn decode(
    out: &mut Out,
    seg_dir: &Path,
    ctx: &mut dyn TagValueValidator,
    full: bool,
    mc: bool,
    positions: &[(i32, i32)],
) -> Result<(), MapError> {
    let store = segment_store(seg_dir);
    let mut cache: Option<NodesCache> = None;
    let (mut total_nodes, mut total_links) = (0, 0);
    let mut treeified = 0;
    for (i, &(ilon, ilat)) in positions.iter().enumerate() {
        let detailed = i % 4 == 3;
        let cleanup_mode = (i % 3) as i32;
        let maxmem = if mc && i % 2 == 1 { 200_000 } else { MAXMEM };

        let mut nc = NodesCache::new(&store, ctx, maxmem, &mut cache, detailed)?;
        nc.direct_weaving = !mc;
        nc.nodes_map.cleanup_mode = cleanup_mode;
        out.begin(full || i % 20 == 0);
        out.line(&format!("P {i} {ilon},{ilat} mode={cleanup_mode} detailed={detailed} mc={mc}"));

        let mut seeds = Vec::new();
        if mc {
            let ids: Vec<i64> = match nc.get_segment_for(ilon, ilat, ctx)? {
                None => {
                    out.line("cell size=0");
                    Vec::new()
                }
                Some(seg) => {
                    let size = seg.get_size();
                    let nids = if size == 0 {
                        0
                    } else if i % 5 == 0 {
                        size
                    } else {
                        5
                    };
                    let ids = (0..nids).map(|k| seg.get_id_for_index((k * size / nids) as usize)).collect();
                    out.line(&format!("cell size={size}"));
                    ids
                }
            };
            let partial = ids.len() == 5;
            for id in ids {
                let n = nc.get_graph_node(&Pos::from_id(id));
                let ok = nc.obtain_non_hollow_node(n, ctx)?;
                if partial {
                    out.line(&format!("node {} ok={ok}", node_pos(&nc, n)));
                    if ok {
                        nc.expand_hollow_link_targets(n, ctx)?;
                    }
                }
                seeds.push(n);
            }
        } else {
            let start = nc.get_graph_node(&Pos::new(ilon, ilat));
            let ok = nc.obtain_non_hollow_node(start, ctx)?;
            out.line(&format!("start ok={ok} hollow={}", u8::from(nc.nodes_map.is_hollow(start))));
            seeds.push(start);
            let mut hollow: Vec<NodeIdx> =
                nc.nodes_map.indexed_nodes().filter(|&n| nc.nodes_map.is_hollow(n) && n != start).collect();
            hollow.sort_by_key(|&n| nc.nodes_map.id_from_pos(n));
            if i % 6 == 2 && hollow.len() >= 2 {
                // end nodes stay indexed when loaded
                let (end1, end2) = (hollow[0], hollow[hollow.len() - 1]);
                nc.nodes_map.end_node1 = Some(end1);
                nc.nodes_map.end_node2 = Some(end2);
                let ok1 = nc.obtain_non_hollow_node(end1, ctx)?;
                let ok2 = nc.obtain_non_hollow_node(end2, ctx)?;
                out.line(&format!("ends {} {ok1} {} {ok2}", node_pos(&nc, end1), node_pos(&nc, end2)));
            }
            let nexp = if i % 2 == 0 { 3 } else { 1 };
            for k in 0..nexp {
                if hollow.is_empty() {
                    break;
                }
                let h = hollow[k * hollow.len() / nexp];
                let ok = nc.obtain_non_hollow_node(h, ctx)?;
                out.line(&format!("expand {} ok={ok}", node_pos(&nc, h)));
            }
            if !nc.nodes_map.is_hollow(start) {
                nc.expand_hollow_link_targets(start, ctx)?;
            }
            out.line(&format!("hollowTargets {}", nc.has_hollow_link_targets(start)));
        }
        out.line(&format!(
            "elev {} {}",
            nc.get_elevation_type(ilon, ilat),
            nc.get_elevation_type(ilon, ilat + 2_000_000)
        ));
        dump_index(out, &nc);
        out.line(&format!("created {}", nc.nodes_map.nodes_created));
        dump_graph(out, "loaded", &nc, &seeds);
        let nodes = reachable(&nc, &seeds);
        total_nodes += nodes.len();
        total_links += nodes.iter().map(|&n| chain(&nc, n).len()).sum::<usize>();

        if i % 5 == 1 {
            let real = non_hollow(&nc, &nodes);
            router_ops(out, &mut nc, &real);
            dump_graph(out, "unlinked", &nc, &seeds);
        }

        // memory checks
        let nm = &mut nc.nodes_map;
        nm.destination = Some(Pos::new(ilon + 20_000, ilat + 10_000));
        nm.current_max_cost = 1000 + (i % 5) as i32 * 700;
        nm.current_path_cost = 100 * (i % 7) as i32;
        let b1 = nm.is_in_memory_bounds(1000 * (i % 10) as i32, false);
        let b2 = nm.is_in_memory_bounds(500, true);
        out.line(&format!("bounds {b1} {b2}"));
        nm.collect_outreachers()?;
        out.line(&format!("outreach created={}", nm.nodes_created));
        let candidates = non_hollow(&nc, &reachable(&nc, &seeds));
        let mut escapes: Vec<NodeIdx> = Vec::new();
        if !candidates.is_empty() {
            escapes.extend((0..5).map(|k| candidates[k * candidates.len() / 5]));
        }
        for &n in &candidates {
            if nc.nodes_map.node(n).visit_id < nc.nodes_map.base_id && escapes.len() < 10 {
                escapes.push(n); // islands
            }
        }
        for n in escapes {
            let esc = nc.nodes_map.can_escape(n);
            out.line(&format!("escape {} {esc} created={}", node_pos(&nc, n), nc.nodes_map.nodes_created));
        }
        nc.nodes_map.clear_temp();
        dump_graph(out, "collected", &nc, &seeds);
        treeified += nc.nodes_map.treeified_buckets();

        // a fresh cache for getStartNode on a real node
        let real = non_hollow(&nc, &nodes);
        if i % 3 == 0 && !real.is_empty() {
            let r = real[real.len() / 2];
            let rid = nc.nodes_map.id_from_pos(r);
            let rpos = node_pos(&nc, r);
            let mut nc2 = NodesCache::new(&store, ctx, maxmem, &mut Some(nc), detailed)?;
            nc2.direct_weaving = !mc;
            let s = nc2.get_start_node(rid, ctx)?;
            out.line(&format!("startNode {rpos} {}", s.map_or("null".into(), |s| node_line(&nc2, s))));
            if let Some(s) = s {
                let mut gd = GeometryDecoder::new();
                for l in chain(&nc2, s) {
                    out.line(&link_line(&nc2, s, l, &mut gd));
                    out.line(&node_line(&nc2, nc2.nodes_map.target(l, s)));
                }
            }
            out.line(&format!("created {}", nc2.nodes_map.nodes_created));
            treeified += nc2.nodes_map.treeified_buckets();
            nc = nc2;
        }
        out.line(&format!("status {}", nc.format_status()));
        out.end(&format!("pos{i}"));
        cache = Some(nc);
    }
    out.raw(&format!("T positions={} nodes={total_nodes} links={total_links}", positions.len()));
    if treeified > 0 {
        eprintln!("warning: {treeified} index buckets exceeded Java's treeify threshold");
    }
    Ok(())
}

// ---------------------------------------------------------------------- waypoint matching

fn wpt_line(prefix: &str, m: &MatchedWaypoint) -> String {
    format!(
        "{prefix} {} ty={} wp={} cp={} n1={} n2={} r={} dn={} dd={} ix={}",
        m.name,
        m.wpttype,
        pos(Some(m.waypoint)),
        pos(m.crosspoint),
        pos(m.node1),
        pos(m.node2),
        bits(m.radius),
        bits(m.direction_to_next),
        bits(m.direction_diff),
        m.index_in_track
    )
}

fn waypoints(g: usize, pts: &[(i32, i32)]) -> Vec<MatchedWaypoint> {
    pts.iter()
        .enumerate()
        .map(|(k, &(ilon, ilat))| {
            let mut m = MatchedWaypoint::new(Pos::new(ilon, ilat), format!("g{g}w{k}"));
            if g % 10 == 4 && k == 0 {
                m.wpttype = MatchedWaypoint::WAYPOINT_TYPE_DIRECT;
            }
            m
        })
        .collect()
}

struct Matcher {
    store: Arc<SegmentStore>,
    cache: Option<NodesCache>,
}

impl Matcher {
    fn run(
        &mut self,
        out: &mut Out,
        tag: &str,
        ctx: &mut TestValidator,
        wps: &mut Vec<MatchedWaypoint>,
        range: f64,
        islands: &OsmNodePairSet,
    ) -> Result<bool, MapError> {
        let mut nc = NodesCache::new(&self.store, ctx, MAXMEM, &mut self.cache, false)?;
        let ok = match nc.match_waypoints_to_nodes(wps, range, islands, ctx) {
            Ok(ok) => {
                out.line(&format!("{tag} ok={ok}"));
                ok
            }
            Err(MapError::IllegalArgument(msg)) => {
                out.line(&format!("{tag} EXC {msg}"));
                false
            }
            Err(e) => return Err(e),
        };
        self.cache = Some(nc);
        for m in wps.iter() {
            out.line(&wpt_line("W", m));
            for w in &m.way_nearest {
                out.line(&wpt_line("  w", w));
            }
        }
        Ok(ok)
    }
}

fn match_waypoints(out: &mut Out, seg_dir: &Path, ctx: &mut TestValidator, full: bool) -> Result<(), MapError> {
    let mut rnd = JavaRandom::new(98765);
    let mut islands = OsmNodePairSet::new(1000);
    let mut matcher = Matcher { store: segment_store(seg_dir), cache: None };
    let mut total = 0;
    let mut matched = 0;
    let mut g = 0;
    while total < 520 {
        let n = 1 + rnd.next_int(3);
        let mut base_lon = 190_000_000 + rnd.next_int(10_000_000);
        let mut base_lat = 135_000_000 + rnd.next_int(5_000_000);
        if g % 25 == 7 {
            base_lon = 190_000_000 + rnd.next_int(30_000); // western edge of the data
        }
        if g % 25 == 13 {
            base_lat = 135_000_000 + rnd.next_int(30_000); // southern edge
        }
        let mut pts = Vec::new();
        for k in 0..n {
            if k == 0 {
                pts.push((base_lon, base_lat));
            } else {
                let dlon = rnd.next_int(100_001) - 50_000;
                let dlat = rnd.next_int(100_001) - 50_000;
                pts.push((base_lon + dlon, base_lat + dlat));
            }
        }
        let range = if g % 4 == 3 { -60000. } else { 250. };
        out.begin(full || g % 10 == 0);
        out.line(&format!("M {g} n={n} range={}", range as i32));
        let mut wps = waypoints(g, &pts);
        let ok = matcher.run(out, "match", ctx, &mut wps, range, &islands)?;
        matched += wps.iter().filter(|m| m.crosspoint.is_some()).count();
        if ok && g % 9 == 5 && wps[0].node1.is_some() {
            islands.add_temp_pair(wps[0].node1.unwrap().id_from_pos(), wps[0].node2.unwrap().id_from_pos());
            islands.freeze_temp_pairs();
            out.line(&format!("island {} {}", islands.size(), islands.get_freeze_count()));
            matcher.run(out, "rematch", ctx, &mut waypoints(g, &pts), range, &islands)?;
        }
        out.end(&format!("group{g}"));
        total += n;
        g += 1;
    }
    // edge cases: outside the data, at its edges, in the sea; each with both ranges
    let special: [&[(i32, i32)]; 8] = [
        &[(189_500_000, 136_500_000)],
        &[(190_000_500, 136_500_000)],
        &[(192_000_000, 135_000_500)],
        &[(196_000_000, 139_999_500)],
        &[(193_000_000, 135_200_000)],
        &[(193_000_000, 135_200_000), (193_050_000, 135_250_000)],
        &[(199_999_500, 137_000_000)],
        &[(190_000_500, 136_500_000), (190_020_000, 136_510_000)],
    ];
    for k in 0..special.len() * 2 {
        let pts = special[k / 2];
        let range = if k % 2 == 1 { -60000. } else { 250. };
        out.begin(true);
        out.line(&format!("S {k} n={} range={}", pts.len(), range as i32));
        let mut wps = waypoints(1000 + k, pts);
        matcher.run(out, "special", ctx, &mut wps, range, &islands)?;
        matched += wps.iter().filter(|m| m.crosspoint.is_some()).count();
        out.end(&format!("special{k}"));
        total += pts.len() as i32;
    }
    out.raw(&format!("T waypoints={total} matched={matched}"));
    Ok(())
}

// ---------------------------------------------------------------------- SortedHeap

fn heap(out: &mut Out) {
    let mut rnd = JavaRandom::new(4711);
    let mut h: SortedHeap<i32> = SortedHeap::new();
    let ranges = [3, 10, 100, 1000, 100_000, 1 << 30];
    let mut seq = 0;
    out.begin(true);
    for round in 0..12 {
        if round % 3 == 0 {
            h.clear();
        }
        let range = ranges[round % 6];
        out.line(&format!("R {round} range={range}"));
        for _ in 0..3000 {
            let r = rnd.next_int(10);
            if r < 6 {
                let key = rnd.next_int(range) - if round % 2 == 1 { range / 2 } else { 0 };
                h.add(key, seq);
                out.line(&format!("a {key} {seq}"));
                seq += 1;
            } else if r < 9 {
                let v = h.pop_lowest_key_value();
                out.line(&format!("p {}", v.map_or("null".into(), |v| v.to_string())));
            } else {
                let mut t = vec![None; 1 + rnd.next_int(8) as usize];
                let n = h.get_extract(&mut t);
                let mut s = format!("e {n}");
                for v in &t[..n] {
                    write!(s, " {}", v.expect("extracted value")).unwrap();
                }
                out.line(&s);
            }
        }
        out.line(&format!("size {} peak {}", h.get_size(), h.get_peak_size()));
        if round % 3 == 2 {
            while let Some(v) = h.pop_lowest_key_value() {
                out.line(&format!("p {v}"));
            }
        }
    }
    out.end("heap");
}

// ---------------------------------------------------------------------- CheapRuler / CheapAngleMeter

fn ruler(out: &mut Out) {
    out.begin(true);
    for i in 0..1800 {
        let kxky = cheap_ruler::get_lon_lat_to_meter_scales(i * 100_000);
        out.line(&format!("s {i} {} {}", bits(kxky[0]), bits(kxky[1])));
    }
    let mut rnd = JavaRandom::new(77);
    let mut am = CheapAngleMeter::default();
    for i in 0..20000 {
        let lon0 = 190_000_000 + rnd.next_int(10_000_000);
        let lat0 = 135_000_000 + rnd.next_int(5_000_000);
        let d = if i % 2 == 0 { 2000 } else { 200_000 };
        let lon1 = lon0 + rnd.next_int(2 * d + 1) - d;
        let lat1 = lat0 + rnd.next_int(2 * d + 1) - d;
        let lon2 = lon1 + rnd.next_int(2 * d + 1) - d;
        let lat2 = lat1 + rnd.next_int(2 * d + 1) - d;
        let dist = cheap_ruler::distance(lon0, lat0, lon1, lat1);
        let dir = CheapAngleMeter::get_direction(lon0, lat0, lon1, lat1);
        let diff =
            CheapAngleMeter::get_difference_from_direction(dir, CheapAngleMeter::get_direction(lon1, lat1, lon2, lat2));
        let angle = am.calc_angle(lon0, lat0, lon1, lat1, lon2, lat2);
        let a = Pos::new(lon0, lat0);
        out.line(&format!(
            "r {} {} {} {} {} {} {}",
            bits(dist),
            bits(dir),
            bits(diff),
            bits(angle),
            bits(am.get_cos_angle()),
            a.calc_distance(&Pos::new(lon1, lat1)),
            bits(CheapAngleMeter::normalize(dir - f64::from(720 * (i % 3))))
        ));
    }
    out.end("ruler");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `DataDump heap` printed `D heap lines=47020 fnv=c559c4ad5d5ef9c2`.
    #[test]
    fn sorted_heap_matches_java() {
        let mut out = Out::new(std::io::sink());
        heap(&mut out);
        assert_eq!((out.lines, out.fnv), (47020, 0xc559_c4ad_5d5e_f9c2));
    }

    /// `DataDump ruler` printed `D ruler lines=21800 fnv=2725eb2e0c0938fa`.
    #[test]
    fn cheap_ruler_and_angles_match_java() {
        let mut out = Out::new(std::io::sink());
        ruler(&mut out);
        assert_eq!((out.lines, out.fnv), (21800, 0x2725_eb2e_0c09_38fa));
    }
}

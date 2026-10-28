//! Routes a few requests through the library as BRouter's server would and checks the answers against
//! digests of what the Java reference (BRouter 1.7.10, `parity/java/router/RouteReference.java`)
//! answered. Needs the routing segments and profiles: `RICHIROUTE_SEGMENTS`, `RICHIROUTE_PROFILES`
//! (defaults from `PORTING.md`); skipped when they are missing. `parity/route.sh` compares far more.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use brouter_router::{Answer, LocalRules, Router, RouterPool, SegmentStore, SurfaceFile};

fn data_dir(var: &str, default: &str) -> PathBuf {
    std::env::var_os(var).map_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join(default), PathBuf::from)
}

fn fnv1a(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3))
}

fn data() -> Option<(PathBuf, PathBuf)> {
    let segments = data_dir("RICHIROUTE_SEGMENTS", "../../../richiroute-ubuntu-benchmark/data");
    let profiles = data_dir("RICHIROUTE_PROFILES", "../../experiments/routing/.local/local-routing-rules/profiles");
    if !segments.join("E15_N45.rd5").exists() || !profiles.join("richi-local-v1.brf").exists() {
        eprintln!("skipped: routing segments or profiles missing ({}, {})", segments.display(), profiles.display());
        return None;
    }
    Some((segments, profiles))
}

#[test]
fn answers_match_java() {
    let Some((segments, profiles)) = data() else { return };
    let search = "profile%3Apass1coefficient=2&profile%3Apass2coefficient=0.7";
    let cases = [
        // A to B in Graz, a round trip from Graz, a snap (a leg to the same point), a point without data
        (
            format!(
                "profile=richi-local-v1&lonlats=15.4395%2C47.0707%7C15.45%2C47.08&format=geojson&alternativeidx=0&{search}"
            ),
            0x50d2_fe96_8aee_bdfa,
        ),
        (
            format!(
                "profile=richi-local-v1&lonlats=15.4395%2C47.0707&format=geojson&alternativeidx=0&engineMode=4\
                 &roundTripDistance=5000&direction=90&roundTripPoints=5&{search}"
            ),
            0x074f_f413_e0d9_6054,
        ),
        (
            "profile=richi-surface-v4&lonlats=15.4395%2C47.0707%7C15.4395%2C47.0707&format=geojson".to_string(),
            0x892c_3fea_5efa_2391,
        ),
        ("profile=richi-local-v1&lonlats=5.0%2C45.5%7C5.1%2C45.6".to_string(), 0x3848_35a4_6053_f89d),
    ];
    let mut router = Router::new(&segments, &profiles);
    for (query, digest) in cases {
        let text = match router.answer(&query, 60_000).expect("no exception") {
            Answer::GeoJson(geojson) => geojson,
            Answer::Error(message) => format!("error: {message}"),
        };
        assert_eq!(fnv1a(&text), digest, "{query}: {}", &text[..text.len().min(200)]);
    }
    let exception = router.answer("profile=richi-local-v1&lonlats=15.4395%2C47.0707", 60_000).unwrap_err();
    assert_eq!(exception.to_string(), "java.lang.IllegalArgumentException: we need two lat/lon points at least!");
}

#[test]
fn terminated_requests_end_at_once() {
    let Some((segments, profiles)) = data() else { return };
    let pool = RouterPool::new(Arc::new(SegmentStore::new(segments, 64 << 20)), profiles, 1, None, None);
    // Graz to Virgen, about three seconds
    let long = "profile=richi-local-v1&lonlats=15.393249%2C47.076551%7C12.456876%2C47.003344&format=geojson";
    let (terminated, (sender, receiver)) = (Arc::new(AtomicBool::new(false)), mpsc::channel());
    let started = Instant::now();
    pool.submit(long.into(), 60_000, Some(terminated.clone()), move |outcome, _| sender.send(outcome).unwrap());
    std::thread::sleep(Duration::from_millis(300));
    terminated.store(true, Relaxed);
    match receiver.recv().expect("an answer") {
        Ok(Ok(Answer::Error(message))) => assert!(message.starts_with("operation killed by thread-priority-watchdog")),
        other => panic!("not ended: {other:?}"),
    }
    assert!(started.elapsed() < Duration::from_secs(1), "ended after {:?}", started.elapsed());

    let (sender, receiver) = mpsc::channel();
    pool.submit(long.into(), 60_000, Some(Arc::new(AtomicBool::new(true))), move |outcome, _| {
        sender.send(outcome).unwrap()
    });
    pool.finish();
    assert!(receiver.recv().is_err(), "a request terminated before it starts gets no answer");
}

/// The rows (distance, cost per km, way tags) of the route the planner gets for `lonlats` with these
/// surface corrections.
fn rows_with_corrections(lonlats: &str, corrections: &str) -> Option<Vec<[String; 3]>> {
    let (segments, profiles) = data()?;
    let file = std::env::temp_dir().join(format!("richi-surfaces-{}-{}.tsv", std::process::id(), fnv1a(corrections)));
    std::fs::write(&file, format!("richiroute-surfaces\t1\n{corrections}")).unwrap();
    let rules = Arc::new(LocalRules::load(&profiles.join("../rules.tsv")).expect("the planner's rules"));
    let surfaces = Some(Arc::new(SurfaceFile::open(&file).unwrap()));
    let segments = Arc::new(SegmentStore::new(segments, 64 << 20));
    let mut router = Router::with_segments(segments, &profiles, Some(rules), surfaces);
    let query = format!(
        "profile=richi-local-v1&lonlats={lonlats}&format=geojson&alternativeidx=0\
         &profile%3Apass1coefficient=2&profile%3Apass2coefficient=0.7"
    );
    let Ok(Answer::GeoJson(geojson)) = router.answer(&query, 60_000) else { panic!("a route") };
    std::fs::remove_file(&file).unwrap();
    let rows = geojson.lines().filter(|line| line.trim_start().starts_with("[\"") && line.contains("\", \""));
    Some(
        rows.skip(1)
            .map(|row| row.trim().split("\", \"").collect::<Vec<_>>())
            .map(|f| [3, 4, 9].map(|i| f[i].into()))
            .collect(),
    )
}

#[test]
fn surface_corrections_change_tags_and_costs() {
    // the untagged service road at the end of the planner's Graz route: its cost and way tags, if used
    let service_road = |correction: &str| {
        let corrections = format!("{correction}\t195449900,137079854 195449840,137079917\n");
        let rows = rows_with_corrections(
            "15.4395%2C47.0707%7C15.45%2C47.08",
            if correction.is_empty() { "" } else { &corrections },
        )?;
        rows.into_iter().find(|[_, _, tags]| tags.starts_with("highway=service")).map(|[_, cost, tags]| (cost, tags))
    };
    let Some(original) = service_road("") else { return };
    assert_eq!(original, ("1200".into(), "highway=service".into()));
    assert_eq!(
        service_road("\tsurface * paved"),
        Some(("1200".into(), "highway=service surface=paved osm:surface=".into()))
    );
    // unpaved, the road costs 13 instead of 1.2: the route takes the main road
    assert_eq!(service_road("\tsurface * unpaved;smoothness * -"), None);
    // corrections lapse where OSM has another surface by now
    assert_eq!(service_road("gravel\tsurface * unpaved"), Some(("1200".into(), "highway=service".into())));
}

#[test]
fn surface_corrections_cover_exactly_the_corrected_piece() {
    // 43 m in the middle of a cycle path north of Graz, with no junction at either end
    let correction =
        "asphalt\tsurface * unpaved;tracktype grade1 grade2;smoothness * -\t195413712,137100230 195413557,137100603\n";
    let Some(rows) = rows_with_corrections("15.413899%2C47.099053%7C15.413711%2C47.101772", correction) else { return };
    let summary: Vec<_> = rows
        .iter()
        .map(|[distance, cost, tags]| (distance.as_str(), cost.as_str(), tags.contains("surface=unpaved")))
        .collect();
    assert_eq!(summary, [("135", "1100", false), ("43", "4100", true), ("134", "1100", false)]);
    assert!(rows[1][2].ends_with("osm:surface=asphalt osm:tracktype=grade1 osm:smoothness=excellent"));
}

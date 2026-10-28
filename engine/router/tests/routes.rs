//! Routes a few requests through the library as BRouter's server would and checks the answers against
//! digests of what the Java reference (BRouter 1.7.10, `parity/java/router/RouteReference.java`)
//! answered. Needs the routing segments and profiles: `RICHIROUTE_SEGMENTS`, `RICHIROUTE_PROFILES`
//! (defaults from `PORTING.md`); skipped when they are missing. `parity/route.sh` compares far more.

use std::path::{Path, PathBuf};

use brouter_router::{Answer, Router};

fn data_dir(var: &str, default: &str) -> PathBuf {
    std::env::var_os(var).map_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join(default), PathBuf::from)
}

fn fnv1a(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3))
}

#[test]
fn answers_match_java() {
    let segments = data_dir("RICHIROUTE_SEGMENTS", "../../../richiroute-ubuntu-benchmark/data");
    let profiles = data_dir("RICHIROUTE_PROFILES", "../../experiments/routing/.local/local-routing-rules/profiles");
    if !segments.join("E15_N45.rd5").exists() || !profiles.join("richi-local-v1.brf").exists() {
        eprintln!("skipped: routing segments or profiles missing ({}, {})", segments.display(), profiles.display());
        return;
    }
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

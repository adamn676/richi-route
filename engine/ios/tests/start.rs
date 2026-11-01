//! Starts the app's server over a `Routing` folder laid out as in the app bundle and asks it for a route
//! in Graz. Needs the routing segments, profiles and rules (`RICHIROUTE_SEGMENTS`, `RICHIROUTE_PROFILES`,
//! `RICHIROUTE_RULES`, defaults from `PORTING.md`); skipped when they are missing.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};

fn data_path(var: &str, default: &str) -> PathBuf {
    std::env::var_os(var).map_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join(default), PathBuf::from)
}

#[test]
fn serves_routes_from_the_bundle_layout() {
    let rules_dir = "../../experiments/routing/.local/local-routing-rules";
    let links = [
        ("segments", data_path("RICHIROUTE_SEGMENTS", "../../../richiroute-ubuntu-benchmark/data")),
        ("profiles", data_path("RICHIROUTE_PROFILES", &format!("{rules_dir}/profiles"))),
        ("rules.tsv", data_path("RICHIROUTE_RULES", &format!("{rules_dir}/rules.tsv"))),
    ];
    if let Some((_, missing)) = links.iter().find(|(_, target)| !target.exists()) {
        return eprintln!("skipped: {} missing", missing.display());
    }
    let routing = std::env::temp_dir().join(format!("richi-ios-test-{}", std::process::id()));
    std::fs::create_dir_all(&routing).unwrap();
    for (name, target) in &links {
        std::os::unix::fs::symlink(target, routing.join(name)).unwrap();
    }

    let port = richi_ios::start(&routing, 1).unwrap();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let query = "profile=richi-local-v1&lonlats=15.4395%2C47.0707%7C15.45%2C47.08&format=geojson&alternativeidx=0";
    write!(stream, "GET /brouter?{query} HTTP/1.1\r\n\r\n").unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    std::fs::remove_dir_all(&routing).unwrap();
    assert!(answer.starts_with("HTTP/1.1 200 OK"), "{}", &answer[..answer.len().min(200)]);
    assert!(answer.contains("\"track-length\""));
    assert!(
        richi_ios::start(&routing, 1).unwrap_err().starts_with("Cannot load local routing rules"),
        "the data is gone"
    );
}

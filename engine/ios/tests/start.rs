//! Starts the app's server over a `Routing` folder laid out as in the app bundle, with the segments apart as in
//! the app's data container, and asks it for a route,
//! a leg and loops in Graz. Needs the routing segments, profiles and rules (`RICHIROUTE_SEGMENTS`, `RICHIROUTE_PROFILES`,
//! `RICHIROUTE_RULES`, defaults from `PORTING.md`); skipped when they are missing.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};

fn data_path(var: &str, default: &str) -> PathBuf {
    std::env::var_os(var).map_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join(default), PathBuf::from)
}

#[test]
fn serves_routes_and_loops_from_the_bundle_layout() {
    let rules_dir = "../../experiments/routing/.local/local-routing-rules";
    let segments = data_path("RICHIROUTE_SEGMENTS", "../../../richiroute-ubuntu-benchmark/data");
    let links = [
        ("profiles", data_path("RICHIROUTE_PROFILES", &format!("{rules_dir}/profiles"))),
        ("rules.tsv", data_path("RICHIROUTE_RULES", &format!("{rules_dir}/rules.tsv"))),
    ];
    if let Some(missing) = links.iter().map(|(_, target)| target).chain([&segments]).find(|target| !target.exists()) {
        return eprintln!("skipped: {} missing", missing.display());
    }
    let routing = std::env::temp_dir().join(format!("richi-ios-test-{}", std::process::id()));
    std::fs::create_dir_all(&routing).unwrap();
    for (name, target) in &links {
        std::os::unix::fs::symlink(target, routing.join(name)).unwrap();
    }

    assert!(richi_ios::start(&routing, &routing.join("none"), 4, 1024).unwrap_err().contains("no routing data"));
    // the data container: the segments, and no areas, so no names
    let data = std::env::temp_dir().join(format!("richi-ios-data-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    std::os::unix::fs::symlink(&segments, data.join("segments")).unwrap();
    let port = richi_ios::start(&routing, &data, 4, 1024).unwrap();
    let get = |path: &str| {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let query = "profile=richi-local-v1&lonlats=15.4395%2C47.0707%7C15.45%2C47.08&format=geojson&alternativeidx=0";
        write!(stream, "GET {path}?{query} HTTP/1.1\r\n\r\n").unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).unwrap();
        answer
    };
    let ok = |path: &str| {
        let answer = get(path);
        assert!(answer.starts_with("HTTP/1.1 200 OK"), "{}", &answer[..answer.len().min(200)]);
        answer
    };
    assert!(ok("/brouter").contains("\"track-length\""));
    assert!(ok("/leg").contains("\"distanceMeters\""), "the planner's leg");
    assert!(get("/route").starts_with("HTTP/1.1 404"));
    let name = |query: &str| {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(stream, "GET /name?{query} HTTP/1.1\r\n\r\n").unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).unwrap();
        answer
    };
    assert!(name("lat=47.0707&lon=15.4395").ends_with("{\"name\":null}"), "no areas, no names");
    assert!(name("lat=x").starts_with("HTTP/1.1 400"));

    let body =
        r#"{"profile": "richi-local-v1", "start": [15.4395, 47.0707], "target": {"meters": 3000, "ascent": 30}}"#;
    let ask = |method: &str, mime: &str| {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let head =
            format!("{method} /loops HTTP/1.1\r\nContent-Type: {mime}\r\nContent-Length: {}\r\n\r\n", body.len());
        write!(stream, "{head}{body}").unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).unwrap();
        answer
    };
    // only what a web page cannot send to another site without asking first
    assert!(ask("GET", "application/json").starts_with("HTTP/1.1 405"));
    assert!(ask("POST", "text/plain").starts_with("HTTP/1.1 415"));
    let answer = ask("POST", "application/json; charset=utf-8");
    std::fs::remove_dir_all(&routing).unwrap();
    assert!(answer.starts_with("HTTP/1.1 200 OK"), "{}", &answer[..answer.len().min(200)]);
    assert!(answer.contains("\"heading\""), "loop suggestions");
    assert!(
        richi_ios::start(&routing, &data, 1, 1024).unwrap_err().starts_with("Cannot load local routing rules"),
        "the rules are gone"
    );
    std::fs::remove_dir_all(&data).unwrap();
}

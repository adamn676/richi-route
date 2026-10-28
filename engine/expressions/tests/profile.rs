//! The profile language on a small lookup table and profile (`tests/data`). The full comparison with
//! BRouter runs in `parity/expressions.sh`.

use std::path::{Path, PathBuf};
use std::rc::Rc;

use brouter_codec::TagValueValidator;
use brouter_expressions::{ExpressionContext, NodeContext, Profile, WayContext, read_meta_data};

fn data(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data").join(name)
}

fn load(key_values: &[(String, String)]) -> Profile {
    Profile::load(&data("lookups.dat"), &data("sample.brf"), key_values, 64).expect("sample profile loads")
}

/// A way context of its own, with the given cache size.
fn way_context(hash_size: usize) -> WayContext {
    let mut way = WayContext::new(hash_size);
    read_meta_data(&data("lookups.dat"), Some(&mut way), None).unwrap();
    way.parse_file(&data("sample.brf"), &[]).unwrap();
    way
}

/// Encodes `name=value` tags; a value starting with `#` is a raw value index (1000 and above are
/// numbers in hundredths).
fn describe(ctx: &ExpressionContext, tags: &[(&str, &str)]) -> Vec<u8> {
    let mut ld = ctx.create_new_lookup_data().expect("lookup table read");
    for &(name, value) in tags {
        let key = usize::try_from(ctx.lookup_key(name)).expect("known key");
        ld[key] = match value.strip_prefix('#') {
            Some(raw) => raw.parse().unwrap(),
            None => (0..ctx.lookup_value_count(key))
                .find(|&v| ctx.lookup_value_name(key, v) == value)
                .expect("known value") as i32,
        };
    }
    ctx.encode(&ld).expect("at least one tag")
}

/// A profile file in cargo's scratch directory, for error messages.
fn scratch_profile(name: &str, text: &str) -> PathBuf {
    let path = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    std::fs::write(&path, text).unwrap();
    path
}

#[test]
fn reads_the_lookup_table() {
    let profile = load(&[]);
    assert_eq!(
        (
            profile.way.meta().lookup_version,
            profile.way.meta().lookup_minor_version,
            profile.node.meta().min_app_version
        ),
        (11, 2, -1)
    );
    let way = &profile.way;
    assert_eq!(way.lookup_names(), ["reversedirection", "highway", "surface", "maxspeed", "width"]);
    let highway = way.lookup_key("highway") as usize;
    assert_eq!(way.lookup_value_count(highway), 5);
    assert_eq!(way.lookup_value_name(highway, 4), "track");
    assert_eq!(way.lookup_value_aliases(highway, 4), ["road", "yes"]);
    // the node table's "unknown" line matches the built-in value 1 instead of adding one
    let node = &profile.node;
    assert_eq!(node.lookup_names(), ["nodeaccessgranted", "highway", "barrier"]);
    assert_eq!(node.lookup_value_count(1), 3);
    assert_eq!(way.lookup_key("nosuchkey"), -1);
}

#[test]
fn parses_globals_used_tags_and_no_start_ways() {
    let profile = load(&[]);
    let way = &profile.way;
    assert_eq!(way.variable_value("pass1coefficient", 0.0), 1.5);
    assert_eq!(way.variable_value("speedlimit", 0.0), 40.0);
    assert_eq!(way.variable_value("missing", 7.0), 7.0);
    let used: Vec<&str> = way
        .lookup_names()
        .iter()
        .enumerate()
        .filter(|&(i, _)| way.is_lookup_idx_used(i))
        .map(|(_, n)| n.as_str())
        .collect();
    assert_eq!(used, ["reversedirection", "highway", "maxspeed", "width"]); // surface only appears folded away
    assert_eq!(way.no_start_ways(), [(1, 4)]);
    assert_eq!(profile.node.no_start_ways(), [(1, -1)]); // the node table has no highway=track
    assert!(way.model_class().is_none());
    let read_only: Vec<&str> = way.variables().into_iter().filter(|v| v.2).map(|v| v.0).collect();
    assert_eq!(read_only, ["check_start_way", "pass1coefficient", "speedlimit", "validForBikes"]);
}

#[test]
fn key_values_replace_the_global_assignment_once() {
    let key_values = [("speedlimit".to_string(), "60".to_string()), ("extra".to_string(), "3".to_string())];
    let mut profile = load(&key_values);
    assert_eq!(profile.way.variable_value("speedlimit", 0.0), 60.0);
    assert_eq!(profile.node.variable_value("extra", 0.0), 3.0);
    let d = describe(&profile.way, &[("highway", "residential"), ("maxspeed", "50")]);
    profile.way.evaluate(false, &d).unwrap();
    assert_eq!(profile.way.costfactor(), 1.0); // 50 is no longer above the limit
}

#[test]
fn evaluates_ways_in_both_directions() {
    let mut profile = load(&[]);
    let way = &mut profile.way;
    type Case<'a> = (&'a [(&'a str, &'a str)], f32, f32, f32); // tags, costfactor, turncost, reverse costfactor
    let cases: [Case; 7] = [
        (&[("highway", "primary")], 1.5, 0.0, 2.5),
        (&[("highway", "residential"), ("maxspeed", "50")], 4.0, 90.0, 2.5),
        (&[("highway", "residential"), ("maxspeed", "30")], 1.0, 90.0, 2.5),
        (&[("highway", "residential"), ("maxspeed", "none")], 1.0, 90.0, 2.5), // "none" reads as 0
        (&[("highway", "residential")], 1.0, 90.0, 2.5),                       // no maxspeed: NaN
        (&[("highway", "residential"), ("width", "#1250")], 3.5, 90.0, 2.5),   // width=2.5
        (&[("highway", "track")], 3.0, 90.0, 2.5),
    ];
    for (tags, forward, turncost, reverse) in cases {
        let d = describe(way, tags);
        way.evaluate(false, &d).unwrap();
        assert_eq!((way.costfactor(), way.turncost(), way.priority_classifier()), (forward, turncost, 5.0), "{tags:?}");
        way.evaluate(true, &d).unwrap();
        assert_eq!(way.costfactor(), reverse, "{tags:?}");
        assert_eq!(way.try_access_type(&d).unwrap(), 2);
    }
    let d = describe(way, &[("highway", "residential"), ("width", "#1250")]);
    assert_eq!(way.key_value_description(false, &d), "highway=residential width=2.5");
    assert_eq!(way.key_value_description(true, &d), "reversedirection=yes highway=residential width=2.5");
    assert!(!way.check_start_way(&describe(way, &[("highway", "track")])));
    assert!(way.check_start_way(&d));
}

#[test]
fn node_profiles_read_the_way_results() {
    let mut profile = load(&[]);
    let way_description = describe(&profile.way, &[("highway", "primary")]);
    profile.way.evaluate(false, &way_description).unwrap();
    let signals = describe(&profile.node, &[("highway", "traffic_signals")]);
    profile.node.evaluate(false, &signals, &profile.way).unwrap();
    assert_eq!(profile.node.initialcost(), 15.0);
    assert_eq!(profile.node.key_value_description(true, &signals), "nodeaccessgranted=yes highway=traffic_signals");
    let gate = describe(&profile.node, &[("barrier", "gate")]);
    profile.node.evaluate(false, &gate, &profile.way).unwrap();
    assert_eq!(profile.node.initialcost(), 0.0);
}

#[test]
fn cached_results_equal_fresh_ones_and_unify_shares_descriptions() {
    let mut cached = load(&[]).way;
    let mut fresh = way_context(0);
    let highways = ["residential", "primary", "track"];
    let speeds = ["30", "50", "none"];
    for round in 0..2 {
        for highway in highways {
            for speed in speeds {
                let d = describe(&cached, &[("highway", highway), ("maxspeed", speed)]);
                for reverse in [false, true] {
                    cached.evaluate(reverse, &d).unwrap();
                    fresh.evaluate(reverse, &d).unwrap();
                    let n = cached.build_in_variable_count();
                    let a: Vec<u32> = (0..n).map(|i| cached.build_in_variable(i).to_bits()).collect();
                    let b: Vec<u32> = (0..n).map(|i| fresh.build_in_variable(i).to_bits()).collect();
                    assert_eq!(a, b, "round {round} {highway} {speed} {reverse}");
                }
            }
        }
    }
    let d = describe(&cached, &[("highway", "primary"), ("maxspeed", "30")]);
    let (u1, u2) = (cached.unify(&d, 0, d.len()), cached.unify(&d, 0, d.len()));
    assert!(Rc::ptr_eq(&u1, &u2) && *u1 == *d);

    // a cache of two forgets the oldest description
    let mut small = way_context(2);
    let descriptions: Vec<Vec<u8>> = highways.iter().map(|h| describe(&small, &[("highway", h)])).collect();
    for d in &descriptions {
        small.evaluate(false, d).unwrap();
    }
    let unified = |ctx: &mut WayContext, d: &[u8]| Rc::ptr_eq(&ctx.unify(d, 0, d.len()), &ctx.unify(d, 0, d.len()));
    assert!(!unified(&mut small, &descriptions[0]));
    assert!(unified(&mut small, &descriptions[2]));
}

#[test]
fn reports_errors_like_brouter() {
    let lookups = data("lookups.dat");
    let parse = |text: &str| {
        let file = scratch_profile("broken.brf", text);
        Profile::load(&lookups, &file, &[], 16).err().map(|e| e.to_string())
    };
    assert_eq!(
        parse("---context:global\nassign a = 1\n---context:way\nassign costfactor = nokey=yes\n").as_deref(),
        Some("ParseException broken.brf at line 5: unknown lookup name: nokey")
    );
    assert_eq!(
        parse("---context:global\nassign a = 1\n---context:way\nassign a = 2\n").as_deref(),
        Some("ParseException broken.brf at line 4: cannot assign to readonly variable a")
    );
    assert_eq!(
        parse("---context:global\nassign a = 1\n---context:way\nassign costfactor = 1\n").as_deref(),
        Some("broken.brf does not contain expressions for context node (old version?)")
    );
    assert_eq!(
        parse("---context:global\nassign a = divide 1 0\n").as_deref(),
        Some("ParseException broken.brf at line 3: div by zero")
    );
    let missing = Profile::load(&lookups, Path::new("missing.brf"), &[], 16).err().unwrap();
    assert_eq!(missing.to_string(), "profile missing.brf does not exist");
    let bad_value = Profile::load(&lookups, &data("sample.brf"), &[("a".to_string(), "x".to_string())], 16);
    assert_eq!(bad_value.err().unwrap().to_string(), "ParseException sample.brf at line 1: For input string: \"x\"");
    let no_table =
        read_meta_data(Path::new("missing.dat"), Some(&mut WayContext::new(0)), Some(&mut NodeContext::new()));
    assert_eq!(
        no_table.unwrap_err().to_string(),
        "java.io.FileNotFoundException: missing.dat (No such file or directory)"
    );
}

#[test]
fn evaluation_errors_reach_the_router() {
    let file = scratch_profile(
        "divide.brf",
        "---context:global\nassign a = 1\n---context:way\n\
         assign costfactor = divide 1 highway=track\n---context:node\nassign initialcost = 0\n",
    );
    let mut profile = Profile::load(&data("lookups.dat"), &file, &[], 16).unwrap();
    let d = describe(&profile.way, &[("highway", "primary")]);
    assert_eq!(profile.way.evaluate(false, &d).unwrap_err().to_string(), "div by zero");
    // the decoder's access_type cannot fail: it drops the way, keeps the error and drops every way
    // after it, as Java's exception ends the decoding
    let fine = describe(&profile.way, &[("highway", "track")]);
    assert_eq!(TagValueValidator::access_type(&mut profile.way, &d), 0);
    assert_eq!(TagValueValidator::access_type(&mut profile.way, &fine), 0);
    assert_eq!(profile.way.take_deferred_error().unwrap().to_string(), "div by zero");
    assert!(profile.way.take_deferred_error().is_none());
    assert_eq!(TagValueValidator::access_type(&mut profile.way, &fine), 2);
    // an error nobody took comes back from the next evaluation
    TagValueValidator::access_type(&mut profile.way, &d);
    assert_eq!(profile.way.evaluate(false, &fine).unwrap_err().to_string(), "div by zero");
    profile.way.evaluate(false, &fine).unwrap();
}

#[test]
fn access_type_needs_a_cache_for_closed_ways() {
    let file = scratch_profile(
        "closed.brf",
        "---context:global\nassign a = 1\n---context:way\nassign costfactor = 10000\n\
         ---context:node\nassign initialcost = 0\n",
    );
    let mut way = WayContext::new(0);
    read_meta_data(&data("lookups.dat"), Some(&mut way), None).unwrap();
    way.parse_file(&file, &[]).unwrap();
    let d = describe(&way, &[("highway", "primary")]);
    assert_eq!(way.try_access_type(&d).unwrap_err().to_string(), "Index 20 out of bounds for length 20");
}

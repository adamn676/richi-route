//! Rust side of the profile-language parity check: prints the same text as
//! `parity/java/expressions/ExpressionsParity.java` (see `parity/README.md`).
//!
//! ```text
//! parity_dump numbers STRINGS
//! parity_dump floats            Float.toString of every float, hashed per 2^24 bit patterns
//! parity_dump dump LOOKUPS PROFILE DESCDIR HASHSIZE [KEY=VALUE...]
//! parity_dump globals LOOKUPS PROFILE [KEY=VALUE...]
//! ```

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::rc::Rc;

use brouter_expressions::{ExpressionContext, ExpressionError, NodeContext, Profile, WayContext, java, read_meta_data};

type Out = BufWriter<std::io::StdoutLock<'static>>;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut out = BufWriter::with_capacity(1 << 16, std::io::stdout().lock());
    match args.first().map(String::as_str) {
        Some("numbers") => numbers(&mut out, Path::new(&args[1])),
        Some("dump") => {
            let hash_size = args[4].parse().expect("hash size");
            dump(&mut out, Path::new(&args[1]), Path::new(&args[2]), Some(Path::new(&args[3])), hash_size, &args[5..]);
        }
        Some("floats") => floats(&mut out),
        Some("globals") => dump(&mut out, Path::new(&args[1]), Path::new(&args[2]), None, 1, &args[3..]),
        _ => panic!("usage: parity_dump numbers|dump|globals ..."),
    }
    out.flush().expect("write stdout");
}

fn hex(v: f32) -> String {
    format!("{:08x}", v.to_bits())
}

// ---- numbers ----

/// Java's xorshift over an int.
struct XorShift(u32);

impl XorShift {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }

    fn below(&mut self, n: u32) -> u32 {
        (self.next() >> 1) % n
    }
}

fn numbers(out: &mut Out, strings: &Path) {
    let text = std::fs::read_to_string(strings).expect("read number strings");
    for line in text.lines() {
        match java::parse_float(&unescape(line)) {
            Ok(v) => writeln!(out, "P {line} {}", hex(v)),
            Err(message) => writeln!(out, "P {line} ! {message}"),
        }
        .unwrap();
    }
    for k in 1000..=201_000 {
        print_to_string(out, "S", (k - 1000) as f32 / 100.0);
    }
    for j in 0i32..20_000 {
        print_to_string(out, "S", j.wrapping_mul(107_377).wrapping_add(201_000 - 1000) as f32 / 100.0);
    }
    print_to_string(out, "S", (i32::MAX - 1000) as f32 / 100.0);
    let mut rnd = XorShift(0x9E37_79B9);
    for _ in 0..300_000 {
        print_to_string(out, "R", f32::from_bits(rnd.next()));
    }
    for _ in 0..200_000 {
        let s = random_decimal(&mut rnd);
        match java::parse_float(&s) {
            Ok(v) => writeln!(out, "D {s} {}", hex(v)),
            Err(message) => writeln!(out, "D {s} ! {message}"),
        }
        .unwrap();
    }
}

fn floats(out: &mut Out) {
    let hashes: Vec<u64> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..16u32)
            .map(|worker| {
                scope.spawn(move || {
                    (worker * 16..worker * 16 + 16)
                        .map(|block| {
                            let mut h = 0xcbf2_9ce4_8422_2325u64; // FNV-1a over the lines
                            for low in 0..1u32 << 24 {
                                let s = java::float_to_string(f32::from_bits(block << 24 | low));
                                for b in s.bytes().chain(*b"\n") {
                                    h = (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3);
                                }
                            }
                            h
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        workers.into_iter().flat_map(|w| w.join().expect("worker")).collect()
    });
    for (block, h) in hashes.iter().enumerate() {
        writeln!(out, "F {block} {h:x}").unwrap();
    }
}

fn print_to_string(out: &mut Out, tag: &str, v: f32) {
    let s = java::float_to_string(v);
    let back = java::parse_float(&s).expect("Float.toString parses back");
    writeln!(out, "{tag} {} {s} {}", hex(v), hex(back)).unwrap();
}

fn random_decimal(rnd: &mut XorShift) -> String {
    let mut sb = String::new();
    if rnd.below(4) == 0 {
        sb.push('-');
    }
    let ndigits = 1 + rnd.below(25);
    let point = if rnd.below(3) == 0 { None } else { Some(rnd.below(ndigits + 1)) };
    for i in 0..ndigits {
        if point == Some(i) {
            sb.push('.');
        }
        sb.push(char::from(b'0' + rnd.below(10) as u8));
    }
    if point == Some(ndigits) {
        sb.push('.');
    }
    if rnd.below(2) == 0 {
        sb.push(if rnd.below(2) == 0 { 'e' } else { 'E' });
        match rnd.below(3) {
            1 => sb.push('-'),
            2 => sb.push('+'),
            _ => {}
        }
        write!(sb, "{}", rnd.below(60)).unwrap();
    }
    sb
}

fn unescape(s: &str) -> String {
    let mut sb = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            sb.push(c);
            continue;
        }
        match chars.next().expect("escape") {
            's' => sb.push(' '),
            't' => sb.push('\t'),
            'n' => sb.push('\n'),
            'r' => sb.push('\r'),
            'e' => {} // the empty string
            'u' => {
                let code: String = chars.by_ref().take(4).collect();
                sb.push(char::from_u32(u32::from_str_radix(&code, 16).expect("hex escape")).expect("char"));
            }
            e => sb.push(e),
        }
    }
    sb
}

// ---- dump ----

fn dump(
    out: &mut Out,
    lookups: &Path,
    profile: &Path,
    desc_dir: Option<&Path>,
    hash_size: usize,
    overrides: &[String],
) {
    let key_values: Vec<(String, String)> = overrides
        .iter()
        .map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())).expect("KEY=VALUE"))
        .collect();
    let file_name = profile.file_name().unwrap().to_string_lossy();
    writeln!(out, "profile {file_name}").unwrap();
    let sorted: BTreeMap<_, _> = key_values.iter().map(|(k, v)| (k, v)).collect();
    let sorted: Vec<String> = sorted.iter().map(|(k, v)| format!("{k}={v}")).collect();
    writeln!(out, "overrides {}", sorted.join(" ")).unwrap();

    let Profile { mut way, mut node } = match Profile::load(lookups, profile, &key_values, hash_size) {
        Ok(profile) => profile,
        Err(e) => {
            writeln!(out, "error {e}").unwrap();
            return;
        }
    };
    let meta = way.meta();
    writeln!(out, "meta {} {} {}", meta.lookup_version, meta.lookup_minor_version, meta.min_app_version).unwrap();
    // RoutingContext.readGlobalConfig and its path model, then ProfileCache
    if way.model_class().is_some() {
        let registered = (|| -> Result<(), ExpressionError> {
            way.output_variable_index("maxspeed", false)?;
            way.output_variable_index("maxspeed_explicit", false)?;
            way.output_variable_index("minspeed", false)?;
            node.output_variable_index("maxspeed", false)?;
            Ok(())
        })();
        if let Err(e) = registered {
            writeln!(out, "model error {e}").unwrap();
        }
    }
    if way.variable_value("check_start_way", 1.0) != 1.0 {
        way.free_no_ways();
    }
    if way.variable_value("processUnusedTags", 0.0) != 0.0 {
        way.set_all_tags_used();
    }
    print_context(out, "way", &way);
    print_context(out, "node", &node);
    let Some(desc_dir) = desc_dir else {
        return;
    };

    // a cache-less way context for the full variable sets of each direction
    let mut way_full = WayContext::new(0);
    read_meta_data(lookups, Some(&mut way_full), None).expect("lookup table");
    way_full.parse_file(profile, &key_values).expect("profile");

    let way_descs = read_descriptions(&desc_dir.join("way.txt"));
    let node_descs = read_descriptions(&desc_dir.join("node.txt"));
    if let Err(e) = evaluations(out, &mut way, &mut way_full, &mut node, &way_descs, &node_descs) {
        writeln!(out, "evalerror {e}").unwrap();
    }
}

fn evaluations(
    out: &mut Out,
    way: &mut WayContext,
    way_full: &mut WayContext,
    node: &mut NodeContext,
    way_descs: &[Vec<u8>],
    node_descs: &[Vec<u8>],
) -> Result<(), ExpressionError> {
    let (way_build_in, node_build_in) = (way.build_in_variable_count(), node.build_in_variable_count());
    let (way_variables, node_variables) = (context_variables(way_full), context_variables(node));
    let mut line = String::with_capacity(4096);
    for (i, ab) in way_descs.iter().enumerate() {
        for r in 0..2 {
            let reverse = r == 1;
            line.clear();
            write!(line, "W {i} {r}").unwrap();
            way.evaluate(reverse, ab)?;
            for k in 0..way_build_in {
                write!(line, " {}", hex(way.build_in_variable(k))).unwrap();
            }
            way_full.evaluate(reverse, ab)?;
            line.push_str(" |");
            push_values(&mut line, way_full, &way_variables);
            writeln!(line, " | {}", way.key_value_description(reverse, ab)).unwrap();
            out.write_all(line.as_bytes()).unwrap();
        }
        let access = way.try_access_type(ab)?;
        let start = u8::from(way.check_start_way(ab));
        let (u1, u2) = (unified(way, ab), unified(way, &way_descs[i / 2]));
        writeln!(out, "A {i} {access} {start} {u1}{u2}").unwrap();
        writeln!(out, "D {i}{}", decoded(way_full, ab)).unwrap();
    }
    for (j, ab) in node_descs.iter().enumerate() {
        way.evaluate(j % 2 == 1, &way_descs[j % way_descs.len()])?;
        for f in 0..2 {
            let flag = f == 1;
            line.clear();
            write!(line, "N {j} {f}").unwrap();
            node.evaluate(flag, ab, way)?;
            for k in 0..node_build_in {
                write!(line, " {}", hex(node.build_in_variable(k))).unwrap();
            }
            line.push_str(" |");
            push_values(&mut line, node, &node_variables);
            writeln!(line, " | {}", node.key_value_description(flag, ab)).unwrap();
            out.write_all(line.as_bytes()).unwrap();
        }
        writeln!(out, "E {j}{}", decoded(node, ab)).unwrap();
    }
    Ok(())
}

fn print_context(out: &mut Out, prefix: &str, ctx: &ExpressionContext) {
    for (i, name) in ctx.lookup_names().iter().enumerate() {
        let mut line = format!("{prefix} lookup {name}");
        for v in 0..ctx.lookup_value_count(i) {
            line.push(if v == 0 { ' ' } else { '|' });
            line.push_str(ctx.lookup_value_name(i, v));
            for alias in ctx.lookup_value_aliases(i, v) {
                line.push('/');
                line.push_str(alias);
            }
        }
        writeln!(out, "{line}").unwrap();
    }
    let variables = ctx.variables();
    let readonly = variables.iter().filter(|v| v.2).count();
    writeln!(
        out,
        "{prefix} nodes {} exprs {} vars {} readonly {readonly}",
        ctx.expression_node_count(),
        ctx.expression_count(),
        variables.len()
    )
    .unwrap();
    writeln!(out, "{prefix} model {}", ctx.model_class().unwrap_or("null")).unwrap();
    let build_in: String = (0..ctx.build_in_variable_count())
        .map(|i| if ctx.is_build_in_variable_defined(i) { " 1" } else { " 0" })
        .collect();
    writeln!(out, "{prefix} buildin{build_in}").unwrap();
    let names = ctx.lookup_names();
    let used: String =
        (0..names.len()).filter(|&i| ctx.is_lookup_idx_used(i)).map(|i| format!(" {}", names[i])).collect();
    writeln!(out, "{prefix} used{used}").unwrap();
    let nostart: String = ctx.no_start_ways().iter().map(|&(key, value)| format!(" {}:{value}", names[key])).collect();
    writeln!(out, "{prefix} nostart{nostart}").unwrap();
    for (name, value, readonly) in variables {
        writeln!(out, "{prefix} var {name} {}{}", hex(value), if readonly { " r" } else { "" }).unwrap();
    }
}

/// The context's own (not read-only) variables, sorted by name.
fn context_variables(ctx: &ExpressionContext) -> Vec<String> {
    ctx.variables().into_iter().filter(|v| !v.2).map(|v| v.0.to_string()).collect()
}

fn push_values(line: &mut String, ctx: &ExpressionContext, variables: &[String]) {
    for name in variables {
        write!(line, " {:08x}", ctx.variable_value(name, 0.0).to_bits()).unwrap();
    }
}

/// 1 if two unify calls on copies return the same (cached) description, the second at an offset.
fn unified(ctx: &mut ExpressionContext, ab: &[u8]) -> u8 {
    let mut padded = vec![0; ab.len() + 3];
    padded[3..].copy_from_slice(ab);
    let u1 = ctx.unify(ab, 0, ab.len());
    let u2 = ctx.unify(&padded, 3, ab.len());
    assert!(*u1 == *ab && *u2 == *ab, "unify changed the bytes");
    u8::from(Rc::ptr_eq(&u1, &u2))
}

/// The decoded lookup values and the numbers `v:` reads from them.
fn decoded(ctx: &mut ExpressionContext, ab: &[u8]) -> String {
    let mut ld = ctx.create_new_lookup_data().expect("lookup table read");
    ctx.decode_into(&mut ld, false, ab);
    ctx.decode(ab);
    let mut sb = String::new();
    for (i, &v) in ld.iter().enumerate() {
        if v != 0 {
            write!(sb, " {i}:{v}={}", hex(ctx.lookup_value(i))).unwrap();
        }
    }
    sb
}

fn read_descriptions(file: &Path) -> Vec<Vec<u8>> {
    let text = std::fs::read_to_string(file).expect("read descriptions");
    text.lines()
        .map(|line| {
            (0..line.len() / 2).map(|i| u8::from_str_radix(&line[2 * i..2 * i + 2], 16).expect("hex")).collect()
        })
        .collect()
}

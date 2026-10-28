//! The Rust side of `parity/java/router/FormatParity.java`: reads its dump on stdin and prints every
//! line again with the inputs formatted by this crate. `parity/route.sh formats` diffs the two.

use std::io::{BufRead, Write};

use brouter_router::format::{format_ilat, format_ilon};
use brouter_router::java::{double_to_string, format_0_000};

fn main() {
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("utf-8 input");
        let f: Vec<&str> = line.split(' ').collect();
        let int = |i: usize| f[i].parse::<i32>().expect("number");
        let formatted = match f[0] {
            "E" => format!("E {} {}", f[1], double_to_string(f64::from(int(1)) / 4.0)),
            "D" => {
                let bits = u64::from_str_radix(f[1], 16).expect("hex");
                format!("D {} {}", f[1], double_to_string(f64::from_bits(bits)))
            }
            "T" => {
                let bits = u32::from_str_radix(f[1], 16).expect("hex");
                format!("T {} {}", f[1], format_0_000(f32::from_bits(bits)))
            }
            "P" => format!("P {} {} {} {}", f[1], f[2], format_ilon(int(1)), format_ilat(int(2))),
            other => panic!("unknown line type {other}"),
        };
        writeln!(out, "{formatted}").expect("stdout");
    }
}

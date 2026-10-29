//! `richi-search build <index> <registerDir> <osm.pbf>=<country> …`: builds the index from the BEV address register
//! ("Adresse Relationale Tabellen", its CSV files unpacked in `<registerDir>`) and OpenStreetMap extracts, each named
//! with the country it covers ("austria-latest.osm.pbf=Österreich").
//!
//! `richi-search serve <index> <port> [bindAddress]`: answers the planner as Photon does (`/api/`, `/reverse`), on
//! 127.0.0.1 unless `<bindAddress>` says otherwise.
//!
//! `richi-search query <index> <text> [lon lat]`: prints what a search finds, for trying it out.

#![forbid(unsafe_code)]

mod build;
mod geo;
mod index;
mod search;
mod server;
mod text;

use std::fs::File;
use std::net::TcpListener;
use std::path::Path;
use std::time::Instant;

use index::Index;
use search::{Hit, Query, TypoIndex};

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(2);
}

fn load(path: &str) -> Index {
    let started = Instant::now();
    let file = File::open(path).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
    let index = Index::read(file).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
    eprintln!(
        "{path}: {} places, {} houses, {} road pieces, read in {:.1} s",
        index.docs.len(),
        index.houses.len(),
        index.segments.len(),
        started.elapsed().as_secs_f64()
    );
    index
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("build") if args.len() >= 4 => {
            let started = Instant::now();
            let mut builder = build::Builder::new();
            builder.add_register(Path::new(&args[3])).unwrap_or_else(|e| fail(&e.to_string()));
            let files: Vec<(&Path, &str)> = args[4..]
                .iter()
                .map(|a| {
                    a.split_once('=').unwrap_or_else(|| fail(&format!("{a}: name the file's country, file=country")))
                })
                .map(|(file, country)| (Path::new(file), country))
                .collect();
            let segments = builder.add_osm(&files).unwrap_or_else(|e| fail(&e.to_string()));
            let index = builder.finish(segments);
            let out = File::create(&args[2]).unwrap_or_else(|e| fail(&format!("{}: {e}", args[2])));
            index.write(out).unwrap_or_else(|e| fail(&format!("{}: {e}", args[2])));
            eprintln!(
                "{}: {} places, {} houses, {} terms, {} road pieces in {:.0} s",
                args[2],
                index.docs.len(),
                index.houses.len(),
                index.terms.len(),
                index.segments.len(),
                started.elapsed().as_secs_f64()
            );
        }
        Some("serve") if args.len() >= 4 => {
            let index = load(&args[2]);
            let typos = TypoIndex::new(&index);
            let port = args[3].parse::<u16>().unwrap_or_else(|_| fail("port must be a number from 0 to 65535"));
            let address = args.get(4).map_or("127.0.0.1", String::as_str);
            let listener =
                TcpListener::bind((address, port)).unwrap_or_else(|e| fail(&format!("{address}:{port}: {e}")));
            println!("Search listening on {address}:{port}");
            server::serve(&listener, server::Service { index, typos });
        }
        Some("query") if args.len() >= 4 => {
            let index = load(&args[2]);
            let typos = TypoIndex::new(&index);
            let focus = args.get(4).zip(args.get(5)).and_then(|(lon, lat)| lon.parse().ok().zip(lat.parse().ok()));
            let started = Instant::now();
            let query = Query { text: &args[3], focus, bias_scale: search::DEFAULT_BIAS_SCALE, bbox: None, limit: 10 };
            let hits = search::search(&index, &typos, &query);
            eprintln!("{:.1} ms", started.elapsed().as_secs_f64() * 1000.0);
            for (hit, score) in hits {
                let (doc, number) = match hit {
                    Hit::Doc(d) => (&index.docs[d as usize], None),
                    Hit::House(h) => (
                        &index.docs[index.houses[h as usize].street as usize],
                        index.text(index.houses[h as usize].number),
                    ),
                };
                let kind = &index.kinds[doc.kind as usize];
                println!(
                    "{score:6.2}  {} {}  [{}={}]  {} {}",
                    index.text(doc.name).unwrap_or("–"),
                    number.unwrap_or_default(),
                    kind.key,
                    kind.value,
                    index.text(doc.postcode).unwrap_or_default(),
                    index.text(doc.city).unwrap_or_default()
                );
            }
        }
        _ => fail(
            "usage: richi-search build <index> <registerDir> <osm.pbf>=<country> … | serve <index> <port> [bindAddress] | query <index> <text> [lon lat]",
        ),
    }
}

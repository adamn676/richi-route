//! Builds the index from the Austrian address register (BEV, "Adresse Relationale Tabellen") and OpenStreetMap
//! extracts. The register gives every Austrian address, street and municipality; OpenStreetMap gives towns, mountains,
//! lakes, stations, sights and shops, the roads abroad, and the road lines that name a point on the map.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

use osmpbf::{Element, ElementReader, RelMemberType};

use crate::geo::{Grid, Point, distance_km, gauss_krueger_to_wgs84, in_bbox, mean};
use crate::index::{Doc, House, Index, Kind, NONE, Region, Segment};
use crate::text::{fold, words};

/// What a place of OpenStreetMap is to the search.
struct Class {
    key: &'static str,
    value: String,
    importance: f32,
    kind_type: &'static str,
    /// Words that stand for what it is ("Bahnhof", "Burg"), so "Feldbach Bahnhof" finds the station named Feldbach.
    words: &'static [&'static str],
}

impl Class {
    fn is_street(&self) -> bool {
        self.kind_type == "street"
    }
    fn is_town(&self) -> bool {
        self.kind_type == "city"
    }
    /// A shop or a sight lies at a street; a town, a mountain or a lake does not.
    fn at_street(&self) -> bool {
        matches!(self.key, "amenity" | "shop" | "tourism" | "office" | "craft" | "healthcare" | "building" | "historic")
    }
}

/// The tags used once an object is classified: its names, its address, and what tells how known it is.
const DETAIL_TAGS: &[&str] = &[
    "name",
    "name:de",
    "alt_name",
    "official_name",
    "short_name",
    "loc_name",
    "old_name",
    "addr:street",
    "addr:housenumber",
    "addr:postcode",
    "addr:city",
    "population",
    "wikidata",
    "wikipedia",
];

/// Roads named in reverse lookups: those a ride follows, not tracks and paths.
const NAMED_ROADS: &[&str] = &[
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "living_street",
    "pedestrian",
    "service",
    "cycleway",
    "motorway_link",
    "trunk_link",
    "primary_link",
    "secondary_link",
    "tertiary_link",
    "road",
];

/// What an object with these tags (`tag` gives a tag's value) is, if the search knows it.
fn classify<'a>(tag: impl Fn(&str) -> Option<&'a str>) -> Option<Class> {
    let class = |key, value: &str, importance, kind_type, words| {
        Some(Class { key, value: value.to_string(), importance, kind_type, words })
    };
    if let Some(value) = tag("place") {
        let (importance, kind_type) = match value {
            "city" => (1.0, "city"),
            "town" => (0.85, "city"),
            "municipality" | "village" => (0.75, "city"),
            "suburb" | "borough" => (0.6, "district"),
            "quarter" | "hamlet" => (0.5, "locality"),
            "neighbourhood" => (0.45, "locality"),
            "locality" | "island" => (0.4, "locality"),
            "isolated_dwelling" | "farm" => (0.35, "locality"),
            "square" => (0.45, "street"),
            _ => return None,
        };
        return class("place", value, importance, kind_type, &[]);
    }
    const STATION: &[&str] = &["bahnhof", "bhf", "station", "haltestelle"];
    match tag("railway") {
        Some("station") => return class("railway", "station", 0.65, "other", STATION),
        Some("halt") => return class("railway", "halt", 0.55, "other", STATION),
        _ => {}
    }
    if tag("public_transport") == Some("station") && tag("highway").is_none() {
        return class("railway", "station", 0.6, "other", STATION);
    }
    if tag("aerialway") == Some("station") {
        return class("aerialway", "station", 0.5, "other", &["station", "bergstation", "talstation"]);
    }
    if let Some(value) = tag("mountain_pass").filter(|v| *v != "no") {
        return class("mountain_pass", value, 0.6, "other", &["pass", "sattel"]);
    }
    if let Some(value) = tag("natural") {
        let (importance, words): (f32, &[&str]) = match value {
            "peak" | "volcano" => (0.55, &["berg", "gipfel"]),
            "saddle" => (0.5, &["sattel", "pass"]),
            "mountain_range" | "glacier" => (0.5, &[]),
            "water" => (0.5, &["see", "teich"]),
            "ridge" | "hill" | "valley" | "gorge" | "cave_entrance" | "bay" | "peninsula" => (0.45, &[]),
            "spring" | "cliff" | "rock" | "bare_rock" | "wood" | "heath" | "grassland" | "wetland" => (0.3, &[]),
            _ => return None,
        };
        return class("natural", value, importance, "other", words);
    }
    if let Some(value) = tag("water") {
        return class("water", value, 0.5, "other", &["see", "teich"]);
    }
    match tag("waterway") {
        Some("waterfall") => return class("waterway", "waterfall", 0.45, "other", &["wasserfall"]),
        Some("dam") => return class("waterway", "dam", 0.45, "other", &[]),
        _ => {}
    }
    if let Some(value) = tag("historic") {
        let (importance, words): (f32, &[&str]) = match value {
            "castle" => (0.6, &["burg", "schloss"]),
            "monastery" => (0.6, &["stift", "kloster"]),
            "ruins" => (0.5, &["ruine", "burg"]),
            "church" | "chapel" => (0.45, &["kirche"]),
            "wayside_cross" | "wayside_shrine" | "boundary_stone" | "milestone" | "memorial" | "grave" => return None,
            _ => (0.4, &[]),
        };
        return class("historic", value, importance, "other", words);
    }
    if let Some(value) = tag("tourism") {
        let (importance, words): (f32, &[&str]) = match value {
            "alpine_hut" => (0.55, &["hütte"]),
            "attraction" | "theme_park" | "zoo" => (0.55, &[]),
            "museum" => (0.5, &["museum"]),
            "viewpoint" | "wilderness_hut" | "gallery" => (0.45, &[]),
            "hotel" => (0.4, &["hotel"]),
            "camp_site" => (0.4, &[]),
            "guest_house" | "hostel" | "motel" => (0.35, &["gasthof", "pension"]),
            "information" => return None,
            _ => (0.3, &[]),
        };
        return class("tourism", value, importance, "other", words);
    }
    if let Some(value) = tag("leisure") {
        let importance = match value {
            "stadium" | "water_park" => 0.5,
            "park" | "nature_reserve" | "garden" => 0.45,
            "golf_course" | "marina" | "ice_rink" | "beach_resort" => 0.4,
            "sports_centre" | "swimming_pool" => 0.35,
            "playground" | "picnic_table" | "firepit" | "bleachers" | "outdoor_seating" => return None,
            _ => 0.25,
        };
        return class("leisure", value, importance, "other", &[]);
    }
    if let Some(value) = tag("amenity") {
        let (importance, words): (f32, &[&str]) = match value {
            "hospital" => (0.55, &["krankenhaus", "spital", "klinikum"]),
            "bus_station" => (0.55, &["busbahnhof", "bahnhof"]),
            "ferry_terminal" => (0.55, &[]),
            "monastery" => (0.55, &["stift", "kloster"]),
            "university" | "townhall" => (0.5, &[]),
            "place_of_worship" => (0.45, &["kirche"]),
            "theatre" => (0.45, &["theater"]),
            "restaurant" | "cafe" | "biergarten" | "fuel" | "marketplace" | "cinema" | "arts_centre" | "college"
            | "clinic" => (0.4, &[]),
            "pub"
            | "ice_cream"
            | "pharmacy"
            | "school"
            | "library"
            | "parking"
            | "bicycle_rental"
            | "police"
            | "post_office"
            | "bicycle_repair_station"
            | "courthouse"
            | "events_venue" => (0.35, &[]),
            "bench" | "waste_basket" | "shelter" | "recycling" | "vending_machine" | "bicycle_parking"
            | "parking_space" | "hunting_stand" | "atm" | "telephone" | "post_box" | "taxi" | "parking_entrance"
            | "waste_disposal" | "grit_bin" | "letter_box" | "feeding_place" | "game_feeding" | "clock" => return None,
            _ => (0.3, &[]),
        };
        return class("amenity", value, importance, "other", words);
    }
    if let Some(value) = tag("shop") {
        let importance = if value == "bicycle" { 0.45 } else { 0.3 };
        return class("shop", value, importance, "other", &[]);
    }
    if let Some(value @ ("tower" | "lighthouse" | "water_tower" | "windmill" | "watermill" | "bridge")) =
        tag("man_made")
    {
        let words: &[&str] = match value {
            "tower" | "water_tower" => &["turm"],
            "lighthouse" => &["leuchtturm"],
            _ => &[],
        };
        return class("man_made", value, 0.4, "other", words);
    }
    for key in ["healthcare", "office", "craft"] {
        if let Some(value) = tag(key) {
            return class(key, value, 0.25, "other", &[]);
        }
    }
    if let Some(value) = tag("highway") {
        let importance = match value {
            "bus_stop"
            | "platform"
            | "street_lamp"
            | "crossing"
            | "traffic_signals"
            | "stop"
            | "give_way"
            | "milestone"
            | "elevator"
            | "turning_circle"
            | "speed_camera"
            | "emergency_access_point" => return None,
            "track" | "path" | "footway" | "steps" | "bridleway" => 0.3,
            _ => 0.45,
        };
        return class("highway", value, importance, "street", &[]);
    }
    if let Some(value) = tag("building").filter(|v| *v != "no") {
        let (importance, words): (f32, &[&str]) = match value {
            "monastery" => (0.6, &["stift", "kloster"]),
            "castle" | "palace" => (0.6, &["burg", "schloss"]),
            "train_station" => (0.6, STATION),
            "church" | "cathedral" | "chapel" => (0.45, &["kirche"]),
            "school" | "university" | "hospital" | "hotel" | "stadium" | "museum" => (0.4, &[]),
            _ => (0.3, &[]),
        };
        return class("building", value, importance, "other", words);
    }
    None
}

/// An object of OpenStreetMap the search keeps.
struct Object {
    id: (u8, i64),
    class: Class,
    /// Its `DETAIL_TAGS`.
    tags: Box<[(&'static str, Box<str>)]>,
    /// A node's position.
    point: Option<Point>,
    /// A way's nodes, or a relation's ways.
    refs: Box<[i64]>,
    /// The files it is in, one bit each: the extracts overlap at their borders.
    files: u32,
}

impl Object {
    fn tag(&self, key: &str) -> Option<&str> {
        self.tags.iter().find(|(k, _)| *k == key).map(|(_, v)| &**v)
    }
    fn display_name(&self) -> &str {
        self.tag("name:de").or_else(|| self.tag("name")).unwrap_or_default()
    }
}

/// An address of OpenStreetMap abroad (where the register has none): street, number, postcode and town, separated by
/// `ADDRESS_SEPARATOR`, at a node or at the first node of a building.
struct Address {
    id: (u8, i64),
    fields: Box<str>,
    point: Option<(f32, f32)>,
    first_node: i64,
    files: u32,
}

const ADDRESS_SEPARATOR: &str = "\u{1}";

/// What one element of a file is to the search: a place, an address, or nothing.
enum Found {
    Object(Object),
    Address(Address),
}

fn element(element: Element, file: usize, addresses: bool) -> Option<Found> {
    let (id, tags): ((u8, i64), Vec<(&str, &str)>) = match &element {
        Element::Node(n) => ((0, n.id()), n.tags().collect()),
        Element::DenseNode(n) => ((0, n.id()), n.tags().collect()),
        Element::Way(w) => ((1, w.id()), w.tags().collect()),
        Element::Relation(r) => ((2, r.id()), r.tags().collect()),
    };
    let tag = |key: &str| tags.iter().find(|(k, _)| *k == key).map(|(_, v)| *v);
    let point = match &element {
        Element::Node(n) => Some((n.lon(), n.lat())),
        Element::DenseNode(n) => Some((n.lon(), n.lat())),
        _ => None,
    };
    if (tag("name").is_some() || tag("name:de").is_some())
        && let Some(class) = classify(tag)
    {
        let refs = match &element {
            Element::Way(w) => w.refs().collect(),
            Element::Relation(r) => r
                .members()
                .filter(|m| m.member_type == RelMemberType::Way && matches!(m.role(), Ok("outer" | "")))
                .map(|m| m.member_id)
                .collect(),
            _ => Box::default(),
        };
        let tags = DETAIL_TAGS.iter().filter_map(|&k| tag(k).map(|v| (k, v.into()))).collect();
        return Some(Found::Object(Object { id, class, tags, point, refs, files: 1 << file }));
    }
    let (street, number) = (tag("addr:street")?, tag("addr:housenumber")?);
    if !addresses || street.is_empty() || number.is_empty() {
        return None;
    }
    let fields = [street, number, tag("addr:postcode").unwrap_or_default(), tag("addr:city").unwrap_or_default()];
    let mut address =
        Address { id, fields: fields.join(ADDRESS_SEPARATOR).into(), point: None, first_node: 0, files: 1 << file };
    match element {
        Element::Way(w) => address.first_node = w.refs().next()?,
        Element::Relation(_) => return None,
        _ => address.point = point.map(|(x, y)| (x as f32, y as f32)),
    }
    Some(Found::Address(address))
}

/// What `found` gives for each element of the file at `path`, in no particular order.
fn scan<T: Send>(path: &Path, found: impl Fn(Element) -> Option<T> + Send + Sync) -> io::Result<Vec<T>> {
    ElementReader::from_path(path)
        .and_then(|reader| {
            reader.par_map_reduce(
                |e| found(e).into_iter().collect::<Vec<_>>(),
                Vec::new,
                |mut a, mut b| {
                    a.append(&mut b);
                    a
                },
            )
        })
        .map_err(io::Error::other)
}

/// Positions of the nodes the lines and areas need, by id; filled from all files at once.
struct Nodes {
    ids: Vec<i64>,
    /// Latitude and longitude in 10⁻⁷ degrees, as the files store them; `MISSING` until found.
    positions: Vec<AtomicU64>,
}

const MISSING: u64 = u64::MAX;

impl Nodes {
    fn get(&self, id: i64) -> Option<Point> {
        let i = self.ids.binary_search(&id).ok()?;
        let packed = self.positions[i].load(Relaxed);
        let degrees = |decimicro: u32| 1e-9 * (i64::from(decimicro as i32) * 100) as f64;
        (packed != MISSING).then(|| (degrees(packed as u32), degrees((packed >> 32) as u32)))
    }
}

/// The objects, the addresses abroad, the node lists of the ways their relations are made of, and the positions of
/// the nodes they need.
type OsmData = (Vec<Object>, Vec<Address>, HashMap<i64, Vec<i64>>, Nodes);

/// Finds every named object of the kinds the search knows in the files, and the addresses in the files that `addresses`
/// marks, with the nodes their lines and areas need.
fn read_osm(files: &[&Path], addresses: &[bool]) -> io::Result<OsmData> {
    let (mut objects, mut found_addresses) = (Vec::new(), Vec::new());
    for (file, path) in files.iter().enumerate() {
        let (before, before_addresses) = (objects.len(), found_addresses.len());
        for found in scan(path, |e| element(e, file, addresses[file]))? {
            match found {
                Found::Object(o) => objects.push(o),
                Found::Address(a) => found_addresses.push(a),
            }
        }
        let (named, at) = (objects.len() - before, found_addresses.len() - before_addresses);
        eprintln!("{}: {named} named objects, {at} addresses", path.display());
    }
    // the extracts overlap at their borders: one object, in several files, is kept where it was first found
    let mut first: HashMap<(u8, i64), usize> = HashMap::new();
    let mut repeated = vec![false; objects.len()];
    for i in 0..objects.len() {
        match first.get(&objects[i].id) {
            Some(&j) => {
                objects[j].files |= objects[i].files;
                repeated[i] = true;
            }
            None => {
                first.insert(objects[i].id, i);
            }
        }
    }
    drop(first);
    let mut repeats = repeated.into_iter();
    objects.retain(|_| !repeats.next().unwrap());
    // in a fixed order, so that two builds from the same data are the same
    objects.sort_unstable_by_key(|o| o.id);
    found_addresses.sort_unstable_by_key(|a| a.id);
    found_addresses.dedup_by(|b, a| {
        let same = a.id == b.id;
        if same {
            a.files |= b.files;
        }
        same
    });

    let wanted: HashSet<i64> = objects.iter().filter(|o| o.id.0 == 2).flat_map(|o| o.refs.iter().copied()).collect();
    let mut member_ways: HashMap<i64, Vec<i64>> = HashMap::new();
    if !wanted.is_empty() {
        for path in files {
            member_ways.extend(scan(path, |e| match e {
                Element::Way(w) if wanted.contains(&w.id()) => Some((w.id(), w.refs().collect())),
                _ => None,
            })?);
        }
    }

    let mut ids: Vec<i64> = objects
        .iter()
        .filter(|o| o.id.0 == 1)
        .flat_map(|o| o.refs.iter().copied())
        .chain(member_ways.values().flatten().copied())
        .chain(found_addresses.iter().filter(|a| a.point.is_none()).map(|a| a.first_node))
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids.shrink_to_fit();
    let nodes = Nodes { positions: (0..ids.len()).map(|_| AtomicU64::new(MISSING)).collect(), ids };
    let pack = |lat: i32, lon: i32| u64::from(lon as u32) | (u64::from(lat as u32) << 32);
    for path in files {
        scan(path, |e| {
            let (id, packed) = match e {
                Element::Node(n) => (n.id(), pack(n.decimicro_lat(), n.decimicro_lon())),
                Element::DenseNode(n) => (n.id(), pack(n.decimicro_lat(), n.decimicro_lon())),
                _ => return None::<()>,
            };
            if let Ok(i) = nodes.ids.binary_search(&id) {
                nodes.positions[i].store(packed, Relaxed);
            }
            None
        })?;
    }
    eprintln!(
        "{} objects, {} addresses, {} nodes for their lines and areas",
        objects.len(),
        found_addresses.len(),
        nodes.ids.len()
    );
    Ok((objects, found_addresses, member_ways, nodes))
}

/// Strings, kinds and regions, each stored once.
#[derive(Default)]
struct Interner {
    index: Index,
    strings: HashMap<String, u32>,
    /// By key and type, then value.
    kinds: HashMap<(&'static str, &'static str), HashMap<String, u32>>,
    regions: HashMap<(u32, u32), u32>,
}

impl Interner {
    fn string(&mut self, text: &str) -> u32 {
        if text.is_empty() {
            return NONE;
        }
        if let Some(&id) = self.strings.get(text) {
            return id;
        }
        let id = self.index.strings.len() as u32;
        self.index.strings.push(text.to_string());
        self.strings.insert(text.to_string(), id);
        id
    }
    fn kind(&mut self, key: &'static str, value: &str, kind_type: &'static str) -> u32 {
        let values = self.kinds.entry((key, kind_type)).or_default();
        if let Some(&id) = values.get(value) {
            return id;
        }
        let id = self.index.kinds.len() as u32;
        self.index.kinds.push(Kind { key: key.into(), value: value.into(), kind_type: kind_type.into() });
        values.insert(value.into(), id);
        id
    }
    fn region(&mut self, state: &str, country: &str) -> u32 {
        let wanted = (self.string(state), self.string(country));
        if let Some(&id) = self.regions.get(&wanted) {
            return id;
        }
        let id = self.index.regions.len() as u32;
        self.index.regions.push(Region { state: wanted.0, country: wanted.1 });
        self.regions.insert(wanted, id);
        id
    }
}

/// A place before its words go into the index.
struct Draft {
    doc: Doc,
    names: Vec<String>,
    /// Old, local, official or short names.
    other_names: Vec<String>,
    context: Vec<String>,
}

/// One line of the register's semicolon-separated tables, with its quotes removed.
fn fields(line: &str) -> Vec<String> {
    line.trim_end_matches(['\r', '\n']).split(';').map(|f| f.trim_matches('"').to_string()).collect()
}

fn table(dir: &Path, name: &str, mut row: impl FnMut(&HashMap<&str, usize>, Vec<String>)) -> io::Result<()> {
    let path = dir.join(format!("{name}.csv"));
    let mut lines =
        BufReader::new(File::open(&path).map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", path.display())))?)
            .lines();
    let header = lines.next().ok_or(io::ErrorKind::UnexpectedEof)??;
    let header = fields(header.trim_start_matches('\u{feff}'));
    let columns: HashMap<&str, usize> = header.iter().enumerate().map(|(i, h)| (h.as_str(), i)).collect();
    for line in lines {
        // a row without all columns is left out
        let line = fields(&line?);
        if line.len() >= header.len() {
            row(&columns, line);
        }
    }
    Ok(())
}

/// Words up to where a name says where it lies ("Sankt Radegund bei Graz", "Stubenberg am See", "Bruck an der
/// Mur"): someone typing the name needs only these.
fn core(words: &[String]) -> usize {
    const WHERE: &[&str] = &["bei", "b", "am", "an", "a", "im", "in", "ob", "unter", "auf", "nachst"];
    words.iter().skip(1).position(|w| WHERE.contains(&w.as_str())).map_or(words.len(), |i| i + 1)
}

/// The area routing covers (west, south, east, north; the planner's `ROUTING_BOUNDS`): only places there are found.
const BOUNDS: [f64; 4] = [5.0, 45.0, 20.0, 50.0];

fn inside(p: Point) -> bool {
    in_bbox(p, BOUNDS)
}

/// The country whose addresses the register has.
const AUSTRIA: &str = "Österreich";

const STATES: [&str; 9] = [
    "Burgenland",
    "Kärnten",
    "Niederösterreich",
    "Oberösterreich",
    "Salzburg",
    "Steiermark",
    "Tirol",
    "Vorarlberg",
    "Wien",
];

/// The words around a place in `city`, and abroad the own name of that town and its postal town.
fn context(city: &str, town_name: Option<&Vec<String>>) -> Vec<String> {
    let mut context = words(city);
    context.extend(town_name.into_iter().flatten().cloned());
    context
}

/// Words of a locality of the register, without Graz's district numbers ("Graz,05.Bez.:Gries" → graz, gries).
fn locality_words(name: &str) -> Vec<String> {
    words(name).into_iter().filter(|w| w != "bez" && !w.starts_with(|c: char| c.is_ascii_digit())).collect()
}

pub struct Builder {
    interner: Interner,
    drafts: Vec<Draft>,
    houses: Vec<House>,
    /// Streets with houses (of the register, or of OpenStreetMap abroad) by folded name and town, to join
    /// OpenStreetMap's lines to them.
    address_streets: HashMap<(String, u32), u32>,
}

impl Builder {
    pub fn new() -> Builder {
        Builder {
            interner: Interner::default(),
            drafts: Vec::new(),
            houses: Vec::new(),
            address_streets: HashMap::new(),
        }
    }

    /// Every street of the register with its houses.
    pub fn add_register(&mut self, dir: &Path) -> io::Result<()> {
        let mut municipalities = HashMap::new();
        table(dir, "GEMEINDE", |c, f| {
            municipalities.insert(f[c["GKZ"]].clone(), f[c["GEMEINDENAME"]].clone());
        })?;
        let mut localities = HashMap::new();
        table(dir, "ORTSCHAFT", |c, f| {
            localities.insert((f[c["GKZ"]].clone(), f[c["OKZ"]].clone()), f[c["ORTSNAME"]].clone());
        })?;
        struct Street {
            name: String,
            addition: String,
            municipality: String,
            delivery: String,
            houses: Vec<(String, String, String, Point)>,
        }
        let mut streets: HashMap<String, Street> = HashMap::new();
        table(dir, "STRASSE", |c, f| {
            streets.insert(
                f[c["SKZ"]].clone(),
                Street {
                    name: f[c["STRASSENNAME"]].clone(),
                    addition: f[c["STRASSENNAMENZUSATZ"]].clone(),
                    municipality: f[c["GKZ"]].clone(),
                    delivery: f[c["ZUSTELLORT"]].clone(),
                    houses: Vec::new(),
                },
            );
        })?;
        let mut unplaced = 0;
        table(dir, "ADRESSE", |c, f| {
            let point = f[c["RW"]].parse().ok().zip(f[c["HW"]].parse().ok()).zip(f[c["EPSG"]].parse().ok());
            let Some(point) = point.and_then(|((rw, hw), epsg)| gauss_krueger_to_wgs84(rw, hw, epsg)) else {
                unplaced += 1;
                return;
            };
            if let Some(street) = streets.get_mut(&f[c["SKZ"]]) {
                street.houses.push((f[c["HNR_ADR_ZUSAMMEN"]].clone(), f[c["PLZ"]].clone(), f[c["OKZ"]].clone(), point));
            }
        })?;

        let mut streets: Vec<_> = streets.into_iter().filter(|s| !s.1.houses.is_empty()).collect();
        streets.sort_by(|(a_code, a), (b_code, b)| {
            (&a.municipality, &a.name, a_code).cmp(&(&b.municipality, &b.name, b_code))
        });
        for (_, street) in streets {
            let municipality = municipalities.get(&street.municipality).cloned().unwrap_or_default();
            let state = street
                .municipality
                .get(..1)
                .and_then(|d| d.parse::<usize>().ok())
                .and_then(|n| STATES.get(n.checked_sub(1)?));
            let region = self.interner.region(state.copied().unwrap_or_default(), AUSTRIA);
            let mut context = words(&street.delivery);
            context.extend(words(&street.addition));
            let mut seen_localities = HashSet::new();
            for house in &street.houses {
                if seen_localities.insert(&house.2) {
                    let locality = localities.get(&(street.municipality.clone(), house.2.clone()));
                    context.extend(locality.map(|l| locality_words(l)).unwrap_or_default());
                }
            }
            let houses: Vec<_> =
                street.houses.iter().map(|(number, postcode, _, p)| (&**number, &**postcode, *p)).collect();
            self.add_street(street.name, &municipality, region, &houses, context);
        }
        eprintln!(
            "address register: {} streets, {} houses, {unplaced} without a position",
            self.drafts.len(),
            self.houses.len()
        );
        Ok(())
    }

    /// A street with its houses (number, postcode, position), placed at the house nearest their middle until a line of
    /// OpenStreetMap places it.
    fn add_street(
        &mut self,
        name: String,
        city: &str,
        region: u32,
        houses: &[(&str, &str, Point)],
        mut context: Vec<String>,
    ) {
        let mut postcodes: HashMap<&str, usize> = HashMap::new();
        houses.iter().for_each(|h| *postcodes.entry(h.1).or_default() += 1);
        let postcode = postcodes.iter().max_by_key(|(p, n)| (**n, std::cmp::Reverse(**p))).map(|(p, _)| *p);
        let middle = mean(houses.iter().map(|h| h.2)).unwrap();
        let medoid = houses
            .iter()
            .map(|h| h.2)
            .min_by(|a, b| distance_km(*a, middle).total_cmp(&distance_km(*b, middle)))
            .unwrap();
        context.extend(words(city));
        context.extend(postcodes.keys().filter(|p| !p.is_empty()).map(|p| p.to_string()));

        let doc_id = self.drafts.len() as u32;
        let start = self.houses.len() as u32;
        for &(number, postcode, point) in houses {
            let house = House {
                street: doc_id,
                number: self.interner.string(number),
                postcode: self.interner.string(postcode),
                lon: point.0 as f32,
                lat: point.1 as f32,
            };
            self.houses.push(house);
        }
        let city = self.interner.string(city);
        self.address_streets.insert((fold(&name), city), doc_id);
        let doc = Doc {
            name: self.interner.string(&name),
            kind: self.interner.kind("highway", "residential", "street"),
            region,
            lon: medoid.0 as f32,
            lat: medoid.1 as f32,
            postcode: postcode.map_or(NONE, |p| self.interner.string(p)),
            city,
            importance: 0.45,
            houses: (start, self.houses.len() as u32),
            ..Doc::default()
        };
        self.drafts.push(Draft { doc, names: vec![name], other_names: vec![], context });
    }

    /// The house of the register nearest to `p` within `max_km`, by `register`, the grid of the register's houses.
    fn nearest_house(&self, register: &Grid, p: Point, max_km: f64) -> Option<(House, f64)> {
        register
            .nearest(p, max_km, |i| distance_km(p, self.houses[i as usize].point()))
            .map(|(i, d)| (self.houses[i as usize], d))
    }

    /// The objects of OpenStreetMap extracts, each file with the country it covers (in German).
    pub fn add_osm(&mut self, files: &[(&Path, &str)]) -> io::Result<Vec<Segment>> {
        let register = Grid::points(self.houses.iter().enumerate().map(|(i, h)| (i as u32, h.point())));
        let paths: Vec<&Path> = files.iter().map(|f| f.0).collect();
        let austria: u32 = files.iter().enumerate().filter(|(_, f)| f.1 == AUSTRIA).map(|(i, _)| 1 << i).sum();
        // the register has every Austrian address
        let addresses_wanted: Vec<bool> = files.iter().map(|f| f.1 != AUSTRIA).collect();
        let (objects, addresses, member_ways, nodes) = read_osm(&paths, &addresses_wanted)?;
        // Where an object lies, by the extracts it is in; one at a border (in two extracts) lies in Austria only
        // when the register has a house close by. `None` is Austria, else the country abroad.
        let abroad = |found_in: u32, p: Point| -> Option<&str> {
            let elsewhere = found_in & !austria;
            if elsewhere == 0 || found_in & austria != 0 && self.nearest_house(&register, p, 1.0).is_some() {
                return None;
            }
            Some(files[elsewhere.trailing_zeros() as usize].1)
        };

        // Towns abroad name the places around them, so they are placed first.
        struct Placed<'a> {
            object: usize,
            point: Point,
            abroad: Option<&'a str>,
        }
        let mut placed = Vec::new();
        let mut segments_wanted = Vec::new();
        for (i, o) in objects.iter().enumerate() {
            let point = match o.id.0 {
                0 => o.point,
                1 if o.class.is_street() => o.refs.get(o.refs.len() / 2).and_then(|&id| nodes.get(id)),
                1 => mean(o.refs.iter().skip(1).filter_map(|&id| nodes.get(id))),
                _ => mean(o.refs.iter().filter_map(|w| member_ways.get(w)).flatten().filter_map(|&id| nodes.get(id))),
            };
            if o.class.key == "highway" && NAMED_ROADS.contains(&o.class.value.as_str()) {
                segments_wanted.push(i);
            }
            if let Some(point) = point.filter(|&p| inside(p)) {
                placed.push(Placed { object: i, point, abroad: abroad(o.files, point) });
            }
        }

        // towns abroad with their German name and their own ("Marburg an der Drau", "Maribor")
        let abroad_towns: Vec<(&str, Vec<String>, Point)> = placed
            .iter()
            .filter(|p| objects[p.object].class.is_town() && p.abroad.is_some())
            .map(|p| {
                let o = &objects[p.object];
                (o.display_name(), words(o.tag("name").unwrap_or_default()), p.point)
            })
            .collect();
        let abroad_grid = Grid::points(abroad_towns.iter().enumerate().map(|(i, t)| (i as u32, t.2)));
        let town_near = |p: Point| {
            abroad_grid.nearest(p, 10.0, |i| distance_km(p, abroad_towns[i as usize].2)).map(|(i, _)| i as usize)
        };

        // Addresses abroad: one street per folded name and town (the nearest town abroad by its place in
        // `abroad_towns`, else the postal town), with its name, country, postal town and houses.
        type Houses<'a> = (&'a str, &'a str, &'a str, Vec<(&'a str, &'a str, Point)>);
        let mut abroad_streets: HashMap<(String, Result<usize, &str>), Houses> = HashMap::new();
        for a in &addresses {
            let point = a.point.map(|(x, y)| (f64::from(x), f64::from(y))).or_else(|| nodes.get(a.first_node));
            let Some(point) = point.filter(|&p| inside(p)) else { continue };
            let Some(country) = abroad(a.files, point) else { continue };
            let mut fields = a.fields.split(ADDRESS_SEPARATOR);
            let (street, number, postcode, city) =
                (fields.next().unwrap(), fields.next().unwrap(), fields.next().unwrap(), fields.next().unwrap());
            let entry = abroad_streets
                .entry((fold(street), town_near(point).ok_or(city)))
                .or_insert_with(|| (street, country, city, Vec::new()));
            entry.3.push((number, postcode, point));
        }
        let mut abroad_streets: Vec<_> = abroad_streets.into_iter().collect();
        abroad_streets.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        let abroad_houses: usize = abroad_streets.iter().map(|s| s.1.3.len()).sum();
        for ((_, town), (name, country, postal, mut houses)) in abroad_streets {
            houses.sort_by(|a, b| a.0.cmp(b.0));
            houses.dedup_by(|a, b| a.0 == b.0);
            let region = self.interner.region("", country);
            let (city, mut context) = match town {
                Ok(i) => (abroad_towns[i].0, abroad_towns[i].1.clone()),
                Err(city) => (city, Vec::new()),
            };
            context.extend(words(postal));
            self.add_street(name.to_string(), city, region, &houses, context);
        }
        drop(addresses);
        eprintln!("OpenStreetMap abroad: {abroad_houses} addresses");

        // Streets of OpenStreetMap: one place per name and town, at the middle of its longest line (its place in
        // `placed`, and its rank); where an address list has the street, its line places that street instead.
        type Rank = (usize, std::cmp::Reverse<i64>);
        let mut streets: HashMap<(String, u32), (usize, Rank)> = HashMap::new();
        // abroad, the own name of the town an object took and its postal town
        let mut town_names: HashMap<usize, Vec<String>> = HashMap::new();
        let austria_region = self.interner.region("", AUSTRIA);
        let mut added = 0;
        for (j, p) in placed.iter().enumerate() {
            let o = &objects[p.object];
            let name = o.display_name();
            let (city, postcode, region, street) = if let Some(country) = p.abroad {
                // the nearest town names it, as it names the streets; its postal town is said around it
                let mut around = words(o.tag("addr:city").unwrap_or_default());
                let town = town_near(p.point).map(|i| {
                    around.extend(abroad_towns[i].1.iter().cloned());
                    abroad_towns[i].0
                });
                town_names.insert(p.object, around);
                let town = town.or_else(|| o.tag("addr:city"));
                let postcode = o.tag("addr:postcode").map_or(NONE, |pc| self.interner.string(pc));
                let region = self.interner.region("", country);
                (
                    town.map_or(NONE, |t| self.interner.string(t)),
                    postcode,
                    region,
                    o.tag("addr:street").map(str::to_string),
                )
            } else {
                let near = self.nearest_house(&register, p.point, 15.0);
                let street_doc = near.map(|(house, _)| &self.drafts[house.street as usize].doc);
                let street = o.tag("addr:street").map(str::to_string).or_else(|| {
                    let ((_, d), doc) = (near?, street_doc?);
                    (o.class.at_street() && d < 0.1).then(|| self.interner.index.strings[doc.name as usize].clone())
                });
                let postcode = near.filter(|(_, d)| *d < 3.0).map_or(NONE, |(house, _)| house.postcode);
                (street_doc.map_or(NONE, |d| d.city), postcode, street_doc.map_or(austria_region, |d| d.region), street)
            };
            if o.class.is_street() {
                // the longest line, of equally long ones the first mapped
                let rank = (o.refs.len(), std::cmp::Reverse(o.id.1));
                let entry = streets.entry((fold(name), city)).or_insert((j, rank));
                if rank > entry.1 {
                    *entry = (j, rank);
                }
                continue;
            }
            let list = |keys: &[&str]| {
                let mut names: Vec<String> = keys
                    .iter()
                    .filter_map(|k| o.tag(k))
                    .flat_map(|v| v.split(';').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string))
                    .collect();
                names.dedup();
                names
            };
            let names = list(&["name:de", "name"]);
            let mut other_names = list(&["alt_name", "official_name", "short_name", "loc_name", "old_name"]);
            // its article in the German Wikipedia names it as people know it ("Stift Admont" for Benediktinerstift Admont)
            other_names.extend(
                o.tag("wikipedia")
                    .and_then(|w| w.strip_prefix("de:"))
                    .map(|t| t.split(" (").next().unwrap_or(t).to_string()),
            );
            let city_name = self.interner.index.text(city).unwrap_or_default().to_string();
            let mut context = context(&city_name, town_names.get(&p.object));
            context.extend(o.class.words.iter().map(|w| fold(w)));
            context.extend(self.interner.index.text(postcode).map(str::to_string));
            let mut importance = o.class.importance;
            if o.tag("wikidata").is_some() || o.tag("wikipedia").is_some() {
                importance += 0.1;
            }
            if let Some(population) = o.tag("population").and_then(|v| v.replace(['.', ','], "").parse::<f64>().ok()) {
                importance += ((population + 1.0).log10() - 3.0).clamp(0.0, 3.0) as f32 * 0.05;
            }
            // A town named as its municipality says so once ("Weiz, Steiermark").
            let (city, postcode) =
                if o.class.is_town() && fold(&city_name) == fold(name) { (NONE, NONE) } else { (city, postcode) };
            let doc = Doc {
                name: self.interner.string(name),
                kind: self.interner.kind(o.class.key, &o.class.value, o.class.kind_type),
                region,
                lon: p.point.0 as f32,
                lat: p.point.1 as f32,
                street: street.map_or(NONE, |s| self.interner.string(&s)),
                housenumber: o.tag("addr:housenumber").map_or(NONE, |h| self.interner.string(h)),
                postcode,
                city,
                importance,
                ..Doc::default()
            };
            self.drafts.push(Draft { doc, names, other_names, context });
            added += 1;
        }
        let mut joined = 0;
        // in a fixed order, so that two builds from the same data are the same
        let mut streets: Vec<_> = streets.into_iter().collect();
        streets.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        for ((name, city), (j, _)) in streets {
            let p = &placed[j];
            if let Some(&doc) = self.address_streets.get(&(name, city)) {
                let doc = &mut self.drafts[doc as usize].doc;
                if distance_km(doc.point(), p.point) < 1.5 {
                    (doc.lon, doc.lat) = (p.point.0 as f32, p.point.1 as f32);
                    joined += 1;
                }
                continue;
            }
            let o = &objects[p.object];
            let near = if p.abroad.is_some() { None } else { self.nearest_house(&register, p.point, 3.0) };
            let region = match (p.abroad, near) {
                (Some(country), _) => self.interner.region("", country),
                (None, Some((house, _))) => self.drafts[house.street as usize].doc.region,
                (None, None) => austria_region,
            };
            let city_name = self.interner.index.text(city).unwrap_or_default().to_string();
            let mut context = context(&city_name, town_names.get(&p.object));
            context.extend(near.and_then(|(h, _)| self.interner.index.text(h.postcode)).map(str::to_string));
            let doc = Doc {
                name: self.interner.string(o.display_name()),
                kind: self.interner.kind(o.class.key, &o.class.value, o.class.kind_type),
                region,
                lon: p.point.0 as f32,
                lat: p.point.1 as f32,
                postcode: near.map_or(NONE, |(h, _)| h.postcode),
                city,
                importance: o.class.importance,
                ..Doc::default()
            };
            self.drafts.push(Draft { doc, names: vec![o.display_name().to_string()], other_names: vec![], context });
            added += 1;
        }
        eprintln!("OpenStreetMap: {added} places added, {joined} streets of the register placed on their line");

        let mut segments = Vec::new();
        for i in segments_wanted {
            let o = &objects[i];
            let name = self.interner.string(o.display_name());
            let points: Vec<Point> = o.refs.iter().filter_map(|&id| nodes.get(id)).collect();
            for pair in points.windows(2).filter(|pair| inside(pair[0]) || inside(pair[1])) {
                let (a, b) = (pair[0], pair[1]);
                segments.push(Segment { name, a: (a.0 as f32, a.1 as f32), b: (b.0 as f32, b.1 as f32) });
            }
        }
        Ok(segments)
    }

    /// The finished index.
    pub fn finish(self, segments: Vec<Segment>) -> Index {
        // postings of a term: name, other names, context
        let mut terms: HashMap<String, [Vec<u32>; 3]> = HashMap::new();
        let mut docs = Vec::with_capacity(self.drafts.len());
        for (i, draft) in self.drafts.into_iter().enumerate() {
            let id = i as u32;
            let mut name_words = usize::MAX;
            let names = draft.names.iter().map(|n| (n, 0)).chain(draft.other_names.iter().map(|n| (n, 1)));
            for (name, list) in names {
                let mut w = words(name);
                if w.is_empty() {
                    continue;
                }
                // where it lies ("bei Graz", "am See") says where, as the town does
                let place = w.split_off(core(&w));
                if list == 0 {
                    name_words = name_words.min(w.len());
                }
                // also written together ("Mariatrosterstraße")
                let joined = (w.len() > 1).then(|| w.concat());
                for word in w.into_iter().chain(joined) {
                    terms.entry(word).or_default()[list].push(id);
                }
                for word in place {
                    terms.entry(word).or_default()[2].push(id);
                }
            }
            for word in draft.context {
                terms.entry(word).or_default()[2].push(id);
            }
            docs.push(Doc { name_words: name_words.clamp(1, 255) as u8, ..draft.doc });
        }
        let mut terms: Vec<_> = terms.into_iter().collect();
        terms.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        let mut index = self.interner.index;
        for (term, [mut names, mut others, mut context]) in terms {
            names.dedup();
            context.dedup();
            // a name that is also another name counts as the name
            others.dedup();
            others.retain(|d| names.binary_search(d).is_err());
            index.push_term(term, [&names, &others, &context]);
        }
        index.docs = docs;
        index.houses = self.houses;
        index.house_grid = Grid::points(index.houses.iter().enumerate().map(|(i, h)| (i as u32, h.point())));
        index.segment_grid = Grid::new(segments.iter().enumerate().map(|(i, s)| {
            let (a, b) = s.ends();
            (i as u32, [a.0.min(b.0), a.1.min(b.1), a.0.max(b.0), a.1.max(b.1)])
        }));
        index.segments = segments;
        let towns = (0..index.docs.len() as u32)
            .filter(|&i| index.kinds[index.docs[i as usize].kind as usize].kind_type == "city");
        index.town_grid = Grid::points(towns.map(|i| (i, index.docs[i as usize].point())));
        index
    }
}

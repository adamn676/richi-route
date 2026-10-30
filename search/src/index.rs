//! The search index: places with their words, the houses of each street, and the road lines for points set on the
//! map. It is written to one file by `build` and read back whole by `serve`, both streaming. In the file, positions are
//! steps of a millionth of a degree from the one before, and an absent text takes one byte; the grids that find what
//! lies near a point are built again when the file is read.

use std::io::{self, Read, Write};

use crate::geo::{Grid, Point, distance_km};

/// No string.
pub const NONE: u32 = u32::MAX;

/// What a place is, as Photon names it: its OpenStreetMap key and value, and Photon's type
/// (house, street, city, district, locality, other).
pub struct Kind {
    pub key: String,
    pub value: String,
    pub kind_type: String,
}

/// A place found by its name: a town, a street, a mountain, a shop.
#[derive(Clone, Copy)]
pub struct Doc {
    pub name: u32,
    pub kind: u32,
    pub region: u32,
    pub lon: f32,
    pub lat: f32,
    /// Street and house number of a place at an address (a shop, a museum).
    pub street: u32,
    pub housenumber: u32,
    pub postcode: u32,
    pub city: u32,
    pub importance: f32,
    /// Words of its name (the shorter of its name and German name), without where it lies ("bei Graz"), for how much
    /// of the name a search covers.
    pub name_words: u8,
    /// Its houses in `Index::houses`, for a street of the address register.
    pub houses: (u32, u32),
}

impl Doc {
    pub fn point(&self) -> Point {
        (f64::from(self.lon), f64::from(self.lat))
    }
}

impl Default for Doc {
    fn default() -> Doc {
        Doc {
            name: NONE,
            kind: 0,
            region: 0,
            lon: 0.0,
            lat: 0.0,
            street: NONE,
            housenumber: NONE,
            postcode: NONE,
            city: NONE,
            importance: 0.0,
            name_words: 0,
            houses: (0, 0),
        }
    }
}

/// An address of the register: a house number on a street (`Doc`).
#[derive(Clone, Copy)]
pub struct House {
    pub street: u32,
    pub number: u32,
    pub postcode: u32,
    pub lon: f32,
    pub lat: f32,
}

impl House {
    pub fn point(&self) -> Point {
        (f64::from(self.lon), f64::from(self.lat))
    }
}

/// A named road, for naming a point on the map: its points are `Index::road_points` up to `end`, after the road before.
#[derive(Clone, Copy)]
pub struct Road {
    pub name: u32,
    pub end: u32,
}

/// Texts one after another in one string, `ends` saying where each ends: millions of names without a heap block each.
#[derive(Default)]
pub struct Texts {
    data: String,
    ends: Vec<u32>,
}

impl Texts {
    pub fn len(&self) -> usize {
        self.ends.len()
    }
    pub fn is_empty(&self) -> bool {
        self.ends.is_empty()
    }
    pub fn get(&self, i: usize) -> &str {
        let start = if i == 0 { 0 } else { self.ends[i - 1] as usize };
        &self.data[start..self.ends[i] as usize]
    }
    pub fn push(&mut self, text: &str) -> u32 {
        self.data.push_str(text);
        self.ends.push(self.data.len() as u32);
        self.ends.len() as u32 - 1
    }
    pub fn shrink_to_fit(&mut self) {
        self.data.shrink_to_fit();
        self.ends.shrink_to_fit();
    }
    /// The first text, of texts in order, for which `before` is false.
    pub fn partition_point(&self, before: impl Fn(&str) -> bool) -> usize {
        let (mut low, mut high) = (0, self.len());
        while low < high {
            let middle = (low + high) / 2;
            if before(self.get(middle)) { low = middle + 1 } else { high = middle }
        }
        low
    }
}

/// The lists of places a term has: in their name, in another of their names (an old or local name), and around them
/// (town, postcode, what they are).
#[derive(Clone, Copy)]
pub enum List {
    Name,
    OtherName,
    Context,
}

pub const LISTS: [List; 3] = [List::Name, List::OtherName, List::Context];

/// State and country.
#[derive(Clone, Copy)]
pub struct Region {
    pub state: u32,
    pub country: u32,
}

#[derive(Default)]
pub struct Index {
    pub strings: Texts,
    pub kinds: Vec<Kind>,
    pub regions: Vec<Region>,
    pub docs: Vec<Doc>,
    pub houses: Vec<House>,
    pub roads: Vec<Road>,
    pub road_points: Vec<(f32, f32)>,
    /// Folded words in order, each with its three lists of places (`List`): all lists one after another in
    /// `postings`, the end of each in `posting_ends`.
    pub terms: Texts,
    pub postings: Vec<u32>,
    pub posting_ends: Vec<u32>,
    pub house_grid: Grid,
    /// Pieces of road by their first point: piece `p` runs from road point `p` to `p + 1`.
    pub road_grid: Grid,
    /// Places a town's name stands for (city, town, village), by position.
    pub town_grid: Grid,
}

impl Index {
    pub fn text(&self, id: u32) -> Option<&str> {
        (id != NONE).then(|| self.strings.get(id as usize))
    }

    /// The places with `term` in `list`, in order.
    pub fn postings(&self, term: usize, list: List) -> &[u32] {
        let i = term * 3 + list as usize;
        let start = if i == 0 { 0 } else { self.posting_ends[i - 1] as usize };
        &self.postings[start..self.posting_ends[i] as usize]
    }

    /// Adds a term's three lists, after those of the terms before it.
    pub fn push_term(&mut self, term: &str, lists: [&[u32]; 3]) {
        self.terms.push(term);
        for list in lists {
            self.postings.extend_from_slice(list);
            self.posting_ends.push(self.postings.len() as u32);
        }
    }

    /// The house nearest to `p` within `max_km`, with its distance.
    pub fn nearest_house(&self, p: Point, max_km: f64) -> Option<(u32, f64)> {
        self.house_grid.nearest(p, max_km, |i| distance_km(p, self.houses[i as usize].point()))
    }

    /// The piece of road starting at road point `p`.
    pub fn road_piece(&self, p: u32) -> (Point, Point) {
        let point = |i: u32| {
            let (lon, lat) = self.road_points[i as usize];
            (f64::from(lon), f64::from(lat))
        };
        (point(p), point(p + 1))
    }

    /// The name of the road that road point `p` belongs to.
    pub fn road_name(&self, p: u32) -> u32 {
        self.roads[self.roads.partition_point(|r| r.end <= p)].name
    }

    /// The grids of houses, road pieces and towns, from their positions.
    pub fn build_grids(&mut self) {
        self.house_grid = Grid::points(self.houses.iter().enumerate().map(|(i, h)| (i as u32, h.point())));
        let mut start = 0;
        let mut pieces = Vec::with_capacity(self.road_points.len());
        for road in &self.roads {
            pieces.extend(start..road.end.saturating_sub(1));
            start = road.end;
        }
        self.road_grid = Grid::new(pieces.into_iter().map(|p| {
            let (a, b) = self.road_piece(p);
            (p, [a.0.min(b.0), a.1.min(b.1), a.0.max(b.0), a.1.max(b.1)])
        }));
        let towns = (0..self.docs.len() as u32)
            .filter(|&i| self.kinds[self.docs[i as usize].kind as usize].kind_type == "city");
        self.town_grid = Grid::points(towns.map(|i| (i, self.docs[i as usize].point())));
    }

    pub fn term(&self, word: &str) -> Option<usize> {
        let i = self.terms.partition_point(|t| t < word);
        (i < self.terms.len() && self.terms.get(i) == word).then_some(i)
    }

    /// Terms starting with `prefix`.
    pub fn terms_with_prefix(&self, prefix: &str) -> std::ops::Range<usize> {
        let start = self.terms.partition_point(|t| t < prefix);
        let end = self.terms.partition_point(|t| t < prefix || t.starts_with(prefix));
        start..end
    }

    /// Writes the index, and says how many bytes each part took.
    pub fn write(&self, out: impl Write) -> io::Result<Vec<(&'static str, u64)>> {
        let mut w = Writer { out, buffer: Vec::new(), error: None, written: 0, at: (0, 0) };
        let mut parts = Vec::new();
        let mut part = |w: &Writer<_>, name| {
            let before: u64 = parts.iter().map(|&(_, n)| n).sum();
            parts.push((name, w.written + w.buffer.len() as u64 - before));
        };
        w.bytes(MAGIC);
        w.u32(self.strings.len() as u32);
        (0..self.strings.len()).for_each(|i| w.str(self.strings.get(i)));
        w.u32(self.kinds.len() as u32);
        for kind in &self.kinds {
            w.str(&kind.key);
            w.str(&kind.value);
            w.str(&kind.kind_type);
        }
        w.u32(self.regions.len() as u32);
        self.regions.iter().for_each(|r| {
            w.id(r.state);
            w.id(r.country);
        });
        part(&w, "texts");
        w.u32(self.docs.len() as u32);
        // a street's houses follow those of the street before, so a count says where they are
        let out_of_order = || io::Error::new(io::ErrorKind::InvalidInput, "houses out of their streets' order");
        let mut houses = 0;
        for (i, d) in self.docs.iter().enumerate() {
            if d.houses.1 > d.houses.0 {
                let own = self.houses[d.houses.0 as usize..d.houses.1 as usize].iter().all(|h| h.street == i as u32);
                if d.houses.0 != houses || !own {
                    return Err(out_of_order());
                }
                houses = d.houses.1;
            }
            w.id(d.name);
            w.u32(d.kind);
            w.u32(d.region);
            w.position(d.lon, d.lat);
            w.id(d.street);
            w.id(d.housenumber);
            w.id(d.postcode);
            w.id(d.city);
            w.f32(d.importance);
            w.u32(u32::from(d.name_words));
            w.u32(d.houses.1 - d.houses.0);
        }
        if houses as usize != self.houses.len() {
            return Err(out_of_order());
        }
        part(&w, "places");
        w.u32(self.houses.len() as u32);
        for h in &self.houses {
            w.id(h.number);
            // most houses have their street's postcode: 0
            let street = self.docs[h.street as usize].postcode;
            w.u32(if h.postcode == street { 0 } else { h.postcode.wrapping_add(2) });
            w.position(h.lon, h.lat);
        }
        part(&w, "houses");
        w.u32(self.roads.len() as u32);
        let mut start = 0;
        for road in &self.roads {
            w.id(road.name);
            w.u32(road.end - start);
            for &(lon, lat) in &self.road_points[start as usize..road.end as usize] {
                w.position(lon, lat);
            }
            start = road.end;
        }
        part(&w, "roads");
        w.u32(self.terms.len() as u32);
        for i in 0..self.terms.len() {
            w.str(self.terms.get(i));
            LISTS.iter().for_each(|&list| w.postings(self.postings(i, list)));
        }
        part(&w, "words");
        w.finish()?;
        Ok(parts)
    }

    pub fn read(input: impl Read) -> io::Result<Index> {
        let mut r = Reader { input, buffer: Vec::new(), at: 0, end: 0, position: (0, 0) };
        if r.take(MAGIC.len())? != MAGIC {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "not a RichiRoute search index of this version"));
        }
        let mut index = Index::default();
        for _ in 0..r.u32()? {
            r.text_into(&mut index.strings)?;
        }
        index.kinds = (0..r.u32()?)
            .map(|_| Ok(Kind { key: r.str()?, value: r.str()?, kind_type: r.str()? }))
            .collect::<io::Result<_>>()?;
        index.regions =
            (0..r.u32()?).map(|_| Ok(Region { state: r.id()?, country: r.id()? })).collect::<io::Result<_>>()?;
        let mut houses = 0;
        index.docs = (0..r.u32()?)
            .map(|_| {
                let (name, kind, region, (lon, lat)) = (r.id()?, r.u32()?, r.u32()?, r.position()?);
                let (street, housenumber, postcode, city) = (r.id()?, r.id()?, r.id()?, r.id()?);
                let (importance, name_words, count) = (r.f32()?, r.u32()? as u8, r.u32()?);
                houses = u32::checked_add(houses, count).ok_or(io::ErrorKind::InvalidData)?;
                Ok(Doc {
                    name,
                    kind,
                    region,
                    lon,
                    lat,
                    street,
                    housenumber,
                    postcode,
                    city,
                    importance,
                    name_words,
                    houses: (houses - count, houses),
                })
            })
            .collect::<io::Result<_>>()?;
        let count = r.u32()? as usize;
        let mut streets = index.docs.iter().enumerate().filter(|(_, d)| d.houses.1 > d.houses.0);
        let mut street = streets.next();
        index.houses = Vec::with_capacity(count);
        for h in 0..count as u32 {
            while street.is_some_and(|(_, d)| d.houses.1 <= h) {
                street = streets.next();
            }
            let (d, doc) = street.ok_or(io::ErrorKind::InvalidData)?;
            let (number, postcode, (lon, lat)) = (r.id()?, r.u32()?, r.position()?);
            let postcode = if postcode == 0 { doc.postcode } else { postcode.wrapping_sub(2) };
            index.houses.push(House { street: d as u32, number, postcode, lon, lat });
        }
        for _ in 0..r.u32()? {
            let (name, count) = (r.id()?, r.u32()?);
            for _ in 0..count {
                index.road_points.push(r.position()?);
            }
            index.roads.push(Road { name, end: index.road_points.len() as u32 });
        }
        for _ in 0..r.u32()? {
            r.text_into(&mut index.terms)?;
            for _ in 0..3 {
                r.postings_into(&mut index.postings)?;
                index.posting_ends.push(index.postings.len() as u32);
            }
        }
        index.build_grids();
        // lists grown while reading keep up to as much again in reserve
        index.strings.shrink_to_fit();
        index.terms.shrink_to_fit();
        index.road_points.shrink_to_fit();
        index.postings.shrink_to_fit();
        index.posting_ends.shrink_to_fit();
        Ok(index)
    }
}

const MAGIC: &[u8] = b"RichiRoute search 6\n";

/// How much is written or read at once.
const CHUNK: usize = 1 << 20;

/// A position in millionths of a degree.
fn micro(degrees: f32) -> i64 {
    (f64::from(degrees) * 1e6).round() as i64
}

/// Writes in chunks, keeping the first error for `finish`; positions as steps from the one before (`at`).
struct Writer<W: Write> {
    out: W,
    buffer: Vec<u8>,
    error: Option<io::Error>,
    written: u64,
    at: (i64, i64),
}

impl<W: Write> Writer<W> {
    fn bytes(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() >= CHUNK {
            self.flush();
        }
    }
    fn flush(&mut self) {
        if self.error.is_none() {
            self.error = self.out.write_all(&self.buffer).err();
        }
        self.written += self.buffer.len() as u64;
        self.buffer.clear();
    }
    fn finish(mut self) -> io::Result<()> {
        self.flush();
        self.error.map_or_else(|| self.out.flush(), Err)
    }
    fn u64(&mut self, mut value: u64) {
        while value >= 0x80 {
            self.buffer.push(value as u8 | 0x80);
            value >>= 7;
        }
        self.bytes(&[value as u8]);
    }
    fn u32(&mut self, value: u32) {
        self.u64(u64::from(value));
    }
    /// A text id, `NONE` as 0.
    fn id(&mut self, id: u32) {
        self.u32(id.wrapping_add(1));
    }
    fn signed(&mut self, value: i64) {
        self.u64(((value << 1) ^ (value >> 63)) as u64);
    }
    fn position(&mut self, lon: f32, lat: f32) {
        let (x, y) = (micro(lon), micro(lat));
        self.signed(x - self.at.0);
        self.signed(y - self.at.1);
        self.at = (x, y);
    }
    fn f32(&mut self, value: f32) {
        self.bytes(&value.to_le_bytes());
    }
    fn str(&mut self, text: &str) {
        self.u32(text.len() as u32);
        self.bytes(text.as_bytes());
    }
    /// Ascending numbers as the gaps between them.
    fn postings(&mut self, values: &[u32]) {
        self.u32(values.len() as u32);
        let mut last = 0;
        for &value in values {
            self.u32(value - last);
            last = value;
        }
    }
}

/// Reads in chunks: `buffer[at..end]` is read but not yet taken; positions as steps from `position`.
struct Reader<R: Read> {
    input: R,
    buffer: Vec<u8>,
    at: usize,
    end: usize,
    position: (i64, i64),
}

impl<R: Read> Reader<R> {
    fn take(&mut self, n: usize) -> io::Result<&[u8]> {
        if self.end - self.at < n {
            self.buffer.copy_within(self.at..self.end, 0);
            (self.end, self.at) = (self.end - self.at, 0);
            if self.buffer.len() < n.max(CHUNK) {
                self.buffer.resize(n.max(CHUNK), 0);
            }
            while self.end < n {
                match self.input.read(&mut self.buffer[self.end..])? {
                    0 => return Err(io::ErrorKind::UnexpectedEof.into()),
                    read => self.end += read,
                }
            }
        }
        self.at += n;
        Ok(&self.buffer[self.at - n..self.at])
    }
    fn u64(&mut self) -> io::Result<u64> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = self.take(1)?[0];
            value |= u64::from(byte & 0x7f) << shift;
            if byte < 0x80 {
                return Ok(value);
            }
        }
        Err(io::ErrorKind::InvalidData.into())
    }
    fn u32(&mut self) -> io::Result<u32> {
        u32::try_from(self.u64()?).map_err(|_| io::ErrorKind::InvalidData.into())
    }
    fn id(&mut self) -> io::Result<u32> {
        Ok(self.u32()?.wrapping_sub(1))
    }
    fn signed(&mut self) -> io::Result<i64> {
        let value = self.u64()?;
        Ok((value >> 1) as i64 ^ -((value & 1) as i64))
    }
    fn position(&mut self) -> io::Result<(f32, f32)> {
        let step = |at: i64, by: i64| at.checked_add(by).ok_or(io::Error::from(io::ErrorKind::InvalidData));
        let (x, y) = (step(self.position.0, self.signed()?)?, step(self.position.1, self.signed()?)?);
        self.position = (x, y);
        Ok(((x as f64 / 1e6) as f32, (y as f64 / 1e6) as f32))
    }
    fn f32(&mut self) -> io::Result<f32> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn str(&mut self) -> io::Result<String> {
        let n = self.u32()? as usize;
        String::from_utf8(self.take(n)?.to_vec()).map_err(|_| io::ErrorKind::InvalidData.into())
    }
    fn text_into(&mut self, texts: &mut Texts) -> io::Result<()> {
        let n = self.u32()? as usize;
        texts.push(std::str::from_utf8(self.take(n)?).map_err(|_| io::ErrorKind::InvalidData)?);
        Ok(())
    }
    fn postings_into(&mut self, values: &mut Vec<u32>) -> io::Result<()> {
        let n = self.u32()? as usize;
        let mut last = 0u32;
        for _ in 0..n {
            last = last.checked_add(self.u32()?).ok_or(io::ErrorKind::InvalidData)?;
            values.push(last);
        }
        Ok(())
    }
}

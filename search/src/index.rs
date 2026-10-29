//! The search index: places with their words, the houses of each street, and the street lines for points set on the
//! map. It is written to one file by `build` and read back whole by `serve`, both streaming.

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

/// A piece of a named road, for naming a point on the map.
#[derive(Clone, Copy)]
pub struct Segment {
    pub name: u32,
    pub a: (f32, f32),
    pub b: (f32, f32),
}

impl Segment {
    pub fn ends(&self) -> (Point, Point) {
        ((f64::from(self.a.0), f64::from(self.a.1)), (f64::from(self.b.0), f64::from(self.b.1)))
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
    pub strings: Vec<String>,
    pub kinds: Vec<Kind>,
    pub regions: Vec<Region>,
    pub docs: Vec<Doc>,
    pub houses: Vec<House>,
    pub segments: Vec<Segment>,
    /// Folded words in order, each with its three lists of places (`List`): all lists one after another in
    /// `postings`, the end of each in `posting_ends`.
    pub terms: Vec<String>,
    pub postings: Vec<u32>,
    pub posting_ends: Vec<u32>,
    pub house_grid: Grid,
    pub segment_grid: Grid,
    /// Places a town's name stands for (city, town, village), by position.
    pub town_grid: Grid,
}

impl Index {
    pub fn text(&self, id: u32) -> Option<&str> {
        (id != NONE).then(|| self.strings[id as usize].as_str())
    }

    /// The places with `term` in `list`, in order.
    pub fn postings(&self, term: usize, list: List) -> &[u32] {
        let i = term * 3 + list as usize;
        let start = if i == 0 { 0 } else { self.posting_ends[i - 1] as usize };
        &self.postings[start..self.posting_ends[i] as usize]
    }

    /// Adds a term's three lists, after those of the terms before it.
    pub fn push_term(&mut self, term: String, lists: [&[u32]; 3]) {
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

    pub fn term(&self, word: &str) -> Option<usize> {
        self.terms.binary_search_by(|t| t.as_str().cmp(word)).ok()
    }

    /// Terms starting with `prefix`.
    pub fn terms_with_prefix(&self, prefix: &str) -> std::ops::Range<usize> {
        let start = self.terms.partition_point(|t| t.as_str() < prefix);
        let end = start + self.terms[start..].partition_point(|t| t.starts_with(prefix));
        start..end
    }

    pub fn write(&self, out: impl Write) -> io::Result<()> {
        let mut w = Writer { out, buffer: Vec::new(), error: None };
        w.bytes(MAGIC);
        w.u32(self.strings.len() as u32);
        self.strings.iter().for_each(|s| w.str(s));
        w.u32(self.kinds.len() as u32);
        for kind in &self.kinds {
            w.str(&kind.key);
            w.str(&kind.value);
            w.str(&kind.kind_type);
        }
        w.u32(self.regions.len() as u32);
        self.regions.iter().for_each(|r| {
            w.u32(r.state);
            w.u32(r.country);
        });
        w.u32(self.docs.len() as u32);
        for d in &self.docs {
            w.u32(d.name);
            w.u32(d.kind);
            w.u32(d.region);
            w.f32(d.lon);
            w.f32(d.lat);
            w.u32(d.street);
            w.u32(d.housenumber);
            w.u32(d.postcode);
            w.u32(d.city);
            w.f32(d.importance);
            w.u32(u32::from(d.name_words));
            w.u32(d.houses.0);
            w.u32(d.houses.1);
        }
        w.u32(self.houses.len() as u32);
        for h in &self.houses {
            w.u32(h.street);
            w.u32(h.number);
            w.u32(h.postcode);
            w.f32(h.lon);
            w.f32(h.lat);
        }
        w.u32(self.segments.len() as u32);
        for s in &self.segments {
            w.u32(s.name);
            [s.a.0, s.a.1, s.b.0, s.b.1].into_iter().for_each(|v| w.f32(v));
        }
        w.u32(self.terms.len() as u32);
        for (i, term) in self.terms.iter().enumerate() {
            w.str(term);
            LISTS.iter().for_each(|&list| w.postings(self.postings(i, list)));
        }
        for grid in [&self.house_grid, &self.segment_grid, &self.town_grid] {
            w.u32(grid.cells.len() as u32);
            grid.cells.iter().for_each(|&(key, end)| {
                w.bytes(&key.to_le_bytes());
                w.u32(end);
            });
            w.u32(grid.items.len() as u32);
            grid.items.iter().for_each(|&item| w.u32(item));
        }
        w.finish()
    }

    pub fn read(input: impl Read) -> io::Result<Index> {
        let mut r = Reader { input, buffer: Vec::new(), at: 0, end: 0 };
        if r.take(MAGIC.len())? != MAGIC {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "not a RichiRoute search index of this version"));
        }
        let strings = (0..r.u32()?).map(|_| r.str()).collect::<io::Result<_>>()?;
        let kinds = (0..r.u32()?)
            .map(|_| Ok(Kind { key: r.str()?, value: r.str()?, kind_type: r.str()? }))
            .collect::<io::Result<_>>()?;
        let regions =
            (0..r.u32()?).map(|_| Ok(Region { state: r.u32()?, country: r.u32()? })).collect::<io::Result<_>>()?;
        let docs = (0..r.u32()?)
            .map(|_| {
                Ok(Doc {
                    name: r.u32()?,
                    kind: r.u32()?,
                    region: r.u32()?,
                    lon: r.f32()?,
                    lat: r.f32()?,
                    street: r.u32()?,
                    housenumber: r.u32()?,
                    postcode: r.u32()?,
                    city: r.u32()?,
                    importance: r.f32()?,
                    name_words: r.u32()? as u8,
                    houses: (r.u32()?, r.u32()?),
                })
            })
            .collect::<io::Result<_>>()?;
        let houses = (0..r.u32()?)
            .map(|_| Ok(House { street: r.u32()?, number: r.u32()?, postcode: r.u32()?, lon: r.f32()?, lat: r.f32()? }))
            .collect::<io::Result<_>>()?;
        let segments = (0..r.u32()?)
            .map(|_| Ok(Segment { name: r.u32()?, a: (r.f32()?, r.f32()?), b: (r.f32()?, r.f32()?) }))
            .collect::<io::Result<_>>()?;
        let mut index = Index { strings, kinds, regions, docs, houses, segments, ..Index::default() };
        let terms = r.u32()? as usize;
        for _ in 0..terms {
            let term = r.str()?;
            let lists = [r.postings()?, r.postings()?, r.postings()?];
            index.push_term(term, lists.each_ref().map(Vec::as_slice));
        }
        for grid in [&mut index.house_grid, &mut index.segment_grid, &mut index.town_grid] {
            grid.cells = (0..r.u32()?)
                .map(|_| Ok((u64::from_le_bytes(r.take(8)?.try_into().unwrap()), r.u32()?)))
                .collect::<io::Result<_>>()?;
            grid.items = (0..r.u32()?).map(|_| r.u32()).collect::<io::Result<_>>()?;
        }
        Ok(index)
    }
}

const MAGIC: &[u8] = b"RichiRoute search 3\n";

/// How much is written or read at once.
const CHUNK: usize = 1 << 20;

/// Writes in chunks, keeping the first error for `finish`.
struct Writer<W: Write> {
    out: W,
    buffer: Vec<u8>,
    error: Option<io::Error>,
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
        self.buffer.clear();
    }
    fn finish(mut self) -> io::Result<()> {
        self.flush();
        self.error.map_or_else(|| self.out.flush(), Err)
    }
    fn u32(&mut self, value: u32) {
        let mut value = value;
        while value >= 0x80 {
            self.buffer.push(value as u8 | 0x80);
            value >>= 7;
        }
        self.bytes(&[value as u8]);
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

/// Reads in chunks: `buffer[at..end]` is read but not yet taken.
struct Reader<R: Read> {
    input: R,
    buffer: Vec<u8>,
    at: usize,
    end: usize,
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
    fn u32(&mut self) -> io::Result<u32> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = self.take(1)?[0];
            value |= u64::from(byte & 0x7f) << shift;
            if byte < 0x80 {
                return u32::try_from(value).map_err(|_| io::ErrorKind::InvalidData.into());
            }
        }
        Err(io::ErrorKind::InvalidData.into())
    }
    fn f32(&mut self) -> io::Result<f32> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn str(&mut self) -> io::Result<String> {
        let n = self.u32()? as usize;
        String::from_utf8(self.take(n)?.to_vec()).map_err(|_| io::ErrorKind::InvalidData.into())
    }
    fn postings(&mut self) -> io::Result<Vec<u32>> {
        let n = self.u32()? as usize;
        let mut last = 0u32;
        (0..n)
            .map(|_| {
                last = last.checked_add(self.u32()?).ok_or(io::ErrorKind::InvalidData)?;
                Ok(last)
            })
            .collect()
    }
}

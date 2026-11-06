//! A route as a FIT course, the file Garmin bike computers take as a course (with its climbs and elevation
//! profile) when it is copied into `Garmin/NewFiles`. Field numbers and types are those of Garmin's FIT
//! profile (`@garmin/fitsdk`'s `profile.js`). A long route goes out in parts (`MAX_COURSE_METERS`).

use std::time::{SystemTime, UNIX_EPOCH};

use crate::json::{Json, push_string};
use crate::leg::{CLIMB_THRESHOLD, Coord, along, ascent};

/// A route by its track, at least two points: `[longitude, latitude]` with the height where known, and the
/// points where it passes its stops.
pub struct Course {
    name: String,
    coordinates: Vec<Coord>,
    elevations: Vec<Option<f64>>,
    stops: Vec<usize>,
}

/// The longest course in one file. A Garmin Edge 840 loads 400 km in about 75 s; on some longer courses it
/// fails computing the turn guidance, and 500 to 600 km take about 4 minutes.
const MAX_COURSE_METERS: f64 = 400_000.0;
/// How far from the even cut a stop may lie to take its place, as a share of the even part.
const STOP_REACH: f64 = 0.1;

/// How far the thinned track may leave the route, sideways and in height: a pixel or two on a bike
/// computer's map at riding zoom. With 2 m and 1 m, a 750 km route would take 180 KB instead of 110.
const SIDEWAYS: f64 = 5.0;
const HEIGHT: f64 = 2.0;
/// The pace the course's times assume (20 km/h); Garmin needs a time at each point.
const SPEED: f64 = 20.0 / 3.6;
const MAX_NAME_BYTES: usize = 64;
/// Seconds from 1970 to FIT's epoch, 31 December 1989.
const FIT_EPOCH: u64 = 631_065_600;

/// `POST /fit`: every part of the course (`Course::split`) in one answer, so no client misses one,
/// `{"parts": [{"name", "fit": the FIT file in base64}, ...]}`, the name as the file has it.
pub fn course_fits(body: &str, created: SystemTime) -> Result<String, String> {
    let mut out = String::from(r#"{"parts":["#);
    for (i, part) in Course::parse(body)?.split().iter().enumerate() {
        out.push_str(if i == 0 { r#"{"name":"# } else { r#",{"name":"# });
        push_string(&mut out, truncate(&part.name, MAX_NAME_BYTES));
        out.push_str(r#","fit":""#);
        push_base64(&mut out, &part.fit(created));
        out.push_str(r#""}"#);
    }
    out.push_str("]}");
    Ok(out)
}

impl Course {
    /// `{"name", "coordinates": [[lon, lat, height or null or left out], ...], "stops": [index into coordinates,
    /// ...]}`, at least two points; `stops` may be left out.
    pub fn parse(body: &str) -> Result<Self, String> {
        let json = Json::parse(body)?;
        let name = match json.get("name") {
            None => "RichiRoute".into(),
            Some(name) => name.str().ok_or("name must be text")?.to_string(),
        };
        let points = json.get("coordinates").and_then(Json::array).filter(|p| p.len() >= 2);
        let points = points.ok_or("coordinates must be a list of at least two points")?;
        let (mut coordinates, mut elevations) = (Vec::with_capacity(points.len()), Vec::with_capacity(points.len()));
        for point in points {
            let point = point.array().unwrap_or_default();
            let finite = |i: usize| point.get(i).and_then(Json::number).filter(|n| n.is_finite());
            match (finite(0), finite(1)) {
                (Some(lon), Some(lat)) if lon.abs() <= 180.0 && lat.abs() <= 90.0 => {
                    coordinates.push([lon, lat]);
                }
                _ => return Err("a point must be [longitude, latitude, height]".into()),
            }
            elevations.push(match point.get(2) {
                None | Some(Json::Null) => None,
                Some(_) => Some(finite(2).ok_or("a height must be a number")?),
            });
        }
        let stops = match json.get("stops") {
            None => &[][..],
            Some(stops) => stops.array().ok_or("stops must be a list")?,
        };
        let stops = stops
            .iter()
            .map(|stop| {
                let index = stop.number().filter(|&i| i.fract() == 0.0 && i >= 0.0 && i < coordinates.len() as f64);
                index.map(|i| i as usize).ok_or("a stop must be the index of a point")
            })
            .collect::<Result<_, _>>()?;
        Ok(Course { name, coordinates, elevations, stops })
    }

    /// The course in parts of at most `MAX_COURSE_METERS` (`cuts`), each named "<name> (Teil 1/2)" and
    /// beginning where the one before ends; a shorter course stays as it is.
    pub fn split(self) -> Vec<Course> {
        let along = along(&self.coordinates);
        let cuts = cuts(&along, &self.stops);
        if cuts.is_empty() {
            return vec![self];
        }
        // the heights each part misses come from the whole route, not just from its own
        let heights = fill_heights(&self.elevations, &along);
        let ends: Vec<usize> = [0].into_iter().chain(cuts).chain([along.len() - 1]).collect();
        let count = ends.len() - 1;
        let parts = ends.windows(2).enumerate().map(|(i, pair)| {
            let (from, to) = (pair[0], pair[1]);
            let suffix = format!(" (Teil {}/{count})", i + 1);
            Course {
                name: format!("{}{suffix}", truncate(&self.name, MAX_NAME_BYTES - suffix.len())),
                coordinates: self.coordinates[from..=to].to_vec(),
                elevations: (from..=to).map(|point| heights.as_ref().map(|heights| heights[point])).collect(),
                stops: Vec::new(),
            }
        });
        parts.collect()
    }

    /// A number of the course's name and points (FNV-1a), never 0.
    fn serial(&self) -> u32 {
        let words = self.coordinates.iter().flatten().chain(self.elevations.iter().flatten()).map(|v| v.to_bits());
        let bytes = self.name.bytes().chain(words.flat_map(u64::to_le_bytes));
        bytes.fold(0x811c_9dc5u32, |hash, byte| (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193)).max(1)
    }

    /// The course as a FIT file, created at `created`, its times from then on at `SPEED`. The track is
    /// thinned (`thin`); distances are those along the whole track.
    pub fn fit(&self, created: SystemTime) -> Vec<u8> {
        let along = along(&self.coordinates);
        let meters = along[along.len() - 1];
        let heights = fill_heights(&self.elevations, &along);
        let kept = thin(&self.coordinates, heights.as_deref(), &along);
        let start =
            created.duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs()).saturating_sub(FIT_EPOCH) as u32;
        let mut times: Vec<u32> = Vec::with_capacity(kept.len());
        for &i in &kept {
            let time = start.saturating_add((along[i] / SPEED).round() as u32);
            times.push(times.last().map_or(time, |&last| time.max(last.saturating_add(1))));
        }
        let end = *times.last().unwrap_or(&start);
        let first = self.coordinates[0];
        let last = self.coordinates[self.coordinates.len() - 1];

        let mut fit = Writer::default();
        // file_id: course, development. A Garmin takes files with the same maker, serial number and time for
        // one, so the serial number comes from the course itself.
        fit.message(0, 0, &[(0, Enum(6)), (1, U16(255)), (2, U16(0)), (3, U32z(self.serial())), (4, U32(start))]);
        let name = truncate(&self.name, MAX_NAME_BYTES);
        fit.message(1, 31, &[(5, Str(name)), (4, Enum(2))]); // course: name, sport cycling
        let mut lap = vec![
            (253, U32(end)),
            (2, U32(start)),
            (3, I32(semicircles(first[1]))),
            (4, I32(semicircles(first[0]))),
            (5, I32(semicircles(last[1]))),
            (6, I32(semicircles(last[0]))),
            (7, U32((end - start).saturating_mul(1000))), // total_elapsed_time, ms
            (8, U32((end - start).saturating_mul(1000))), // total_timer_time, ms
            (9, U32(centimeters(meters))),                // total_distance
        ];
        if let Some(heights) = &heights {
            let reversed: Vec<f64> = heights.iter().rev().copied().collect();
            lap.push((21, U16(ascent(heights).round().min(65_534.0) as u16)));
            lap.push((22, U16(ascent(&reversed).round().min(65_534.0) as u16)));
        }
        fit.message(2, 19, &lap);
        fit.message(3, 21, &[(253, U32(start)), (0, Enum(0)), (1, Enum(0))]); // event: timer start
        for (&i, &time) in kept.iter().zip(&times) {
            let [lon, lat] = self.coordinates[i];
            let mut record = vec![
                (253, U32(time)),
                (0, I32(semicircles(lat))),
                (1, I32(semicircles(lon))),
                (5, U32(centimeters(along[i]))),
            ];
            if let Some(heights) = &heights {
                // altitude: scale 5, offset 500 m
                record.push((2, U16(((heights[i] + 500.0) * 5.0).round().clamp(0.0, 65_534.0) as u16)));
            }
            fit.message(4, 20, &record);
        }
        fit.message(3, 21, &[(253, U32(end)), (0, Enum(0)), (1, Enum(9))]); // event: timer stop_disable_all
        fit.finish()
    }
}

/// Where a track of `along` meters is cut into the fewest parts of at most `MAX_COURSE_METERS`, as even as
/// they can be: one cut after the other, each at the stop nearest the even cut of what is left (within
/// `STOP_REACH`), otherwise at the point nearest it, never so that this part or the rest would need more.
fn cuts(along: &[f64], stops: &[usize]) -> Vec<usize> {
    let (last, total) = (along.len() - 1, along[along.len() - 1]);
    let mut cuts = Vec::new();
    let mut from = 0;
    while total - along[from] > MAX_COURSE_METERS && from + 1 < last {
        let parts = ((total - along[from]) / MAX_COURSE_METERS).ceil();
        let even = (total - along[from]) / parts;
        let ideal = along[from] + even;
        let (low, high) = (total - MAX_COURSE_METERS * (parts - 1.0), along[from] + MAX_COURSE_METERS);
        let fits = |i: &usize| *i > from && *i < last && (low..=high).contains(&along[*i]);
        let off = |i: &usize| (along[*i] - ideal).abs();
        let nearest = |a: &usize, b: &usize| off(a).total_cmp(&off(b));
        let stop = stops.iter().copied().filter(|i| fits(i) && off(i) <= STOP_REACH * even).min_by(nearest);
        let reached = along.partition_point(|&meters| meters < ideal);
        let point = [reached - 1, reached].into_iter().filter(fits).min_by(nearest);
        // without a point between `low` and `high` (a segment longer than the slack), as far as allowed
        let farthest = (along.partition_point(|&meters| meters <= high) - 1).max(from + 1);
        from = stop.or(point).unwrap_or(farthest);
        cuts.push(from);
    }
    cuts
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Base64 with padding (RFC 4648).
fn push_base64(out: &mut String, bytes: &[u8]) {
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &byte)| n | u32::from(byte) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() { char::from(BASE64[(n >> (18 - 6 * i) & 63) as usize]) } else { '=' });
        }
    }
}

fn semicircles(degrees: f64) -> i32 {
    (degrees * (f64::from(1u32 << 31) / 180.0)).round() as i32
}

fn centimeters(meters: f64) -> u32 {
    (meters * 100.0).round() as u32
}

fn truncate(text: &str, bytes: usize) -> &str {
    let mut end = text.len().min(bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Every point's height, those missing taken along the track from the known ones on either side (or the
/// nearest); `None` without any.
fn fill_heights(elevations: &[Option<f64>], along: &[f64]) -> Option<Vec<f64>> {
    let known: Vec<usize> = (0..elevations.len()).filter(|&i| elevations[i].is_some()).collect();
    let (&first, &last) = (known.first()?, known.last()?);
    let height = |i: usize| elevations[i].unwrap_or_default();
    let mut next = 0;
    let heights = elevations.iter().enumerate().map(|(i, &elevation)| {
        if let Some(elevation) = elevation {
            return elevation;
        }
        if i < first {
            return height(first);
        }
        if i > last {
            return height(last);
        }
        while known[next] < i {
            next += 1;
        }
        let (before, after) = (known[next - 1], known[next]);
        let span = along[after] - along[before];
        let share = if span > 0.0 { (along[i] - along[before]) / span } else { 0.0 };
        height(before) + (height(after) - height(before)) * share
    });
    Some(heights.collect())
}

/// The points to keep, by Douglas–Peucker: a point goes where the line between the points kept on either
/// side passes within `SIDEWAYS` of it and, along the way, within `HEIGHT` of its height. The ends of
/// every climb stay, so the climbing stays the same. Distances are on a plane through the route's middle
/// latitude.
fn thin(coordinates: &[Coord], heights: Option<&[f64]>, along: &[f64]) -> Vec<usize> {
    let n = coordinates.len();
    let (south, north) = coordinates.iter().fold((90.0f64, -90.0f64), |(s, n), c| (s.min(c[1]), n.max(c[1])));
    let meters_per_degree = 6_371_008.8 * std::f64::consts::PI / 180.0;
    let x_scale = meters_per_degree * ((south + north) / 2.0).to_radians().cos();
    let plane: Vec<[f64; 2]> = coordinates.iter().map(|c| [c[0] * x_scale, c[1] * meters_per_degree]).collect();
    let mut keep = vec![false; n];
    (keep[0], keep[n - 1]) = (true, true);
    for i in heights.map(climb_turns).unwrap_or_default() {
        keep[i] = true;
    }
    let seeds: Vec<usize> = (0..n).filter(|&i| keep[i]).collect();
    let mut sections: Vec<(usize, usize)> = seeds.windows(2).map(|pair| (pair[0], pair[1])).collect();
    while let Some((a, b)) = sections.pop() {
        let mut worst = (1.0, 0);
        for i in a + 1..b {
            let mut error = off_segment(plane[i], plane[a], plane[b]) / SIDEWAYS;
            if let Some(h) = heights {
                let span = along[b] - along[a];
                let share = if span > 0.0 { (along[i] - along[a]) / span } else { 0.0 };
                error = error.max((h[i] - h[a] - (h[b] - h[a]) * share).abs() / HEIGHT);
            }
            if error > worst.0 {
                worst = (error, i);
            }
        }
        if worst.1 > 0 {
            keep[worst.1] = true;
            sections.extend([(a, worst.1), (worst.1, b)]);
        }
    }
    (0..n).filter(|&i| keep[i]).collect()
}

/// Where `ascent` starts and ends each climb: its low and its top.
fn climb_turns(heights: &[f64]) -> Vec<usize> {
    let (mut turns, mut low, mut high) = (Vec::new(), 0, None);
    for (i, &height) in heights.iter().enumerate().skip(1) {
        match high {
            Some(top) if height > heights[top] => high = Some(i),
            Some(top) if height < heights[top] - CLIMB_THRESHOLD => {
                turns.extend([low, top]);
                (low, high) = (i, None);
            }
            Some(_) => {}
            None if height < heights[low] => low = i,
            None if height > heights[low] + CLIMB_THRESHOLD => high = Some(i),
            None => {}
        }
    }
    turns.extend(high.map(|top| [low, top]).into_iter().flatten());
    turns
}

/// The distance from `p` to the segment from `a` to `b` (not its line: a road that turns back is kept).
fn off_segment(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let length = dx * dx + dy * dy;
    let t = if length > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length).clamp(0.0, 1.0) } else { 0.0 };
    (p[0] - a[0] - t * dx).hypot(p[1] - a[1] - t * dy)
}

/// A field's value, which also gives its FIT base type and size.
#[derive(Clone, Copy)]
enum Value<'a> {
    Enum(u8),
    U16(u16),
    U32(u32),
    /// `uint32z`: 0 means no value.
    U32z(u32),
    I32(i32),
    /// Written null-terminated.
    Str(&'a str),
}
use Value::{Enum, I32, Str, U16, U32, U32z};

impl Value<'_> {
    fn base_type(self) -> u8 {
        match self {
            Enum(_) => 0x00,
            U16(_) => 0x84,
            U32(_) => 0x86,
            U32z(_) => 0x8C,
            I32(_) => 0x85,
            Str(_) => 0x07,
        }
    }

    fn size(self) -> usize {
        match self {
            Enum(_) => 1,
            U16(_) => 2,
            U32(_) | U32z(_) | I32(_) => 4,
            Str(text) => text.len() + 1,
        }
    }
}

/// FIT's messages, little-endian: each local message type is defined before its first message and again
/// when its fields change.
#[derive(Default)]
struct Writer {
    data: Vec<u8>,
    /// The definition in force for each local message type.
    defined: [Vec<u8>; 16],
}

impl Writer {
    fn message(&mut self, local: u8, global: u16, fields: &[(u8, Value)]) {
        // definition header, reserved, architecture: little-endian
        let mut definition = vec![0x40 | local, 0, 0];
        definition.extend(global.to_le_bytes());
        definition.push(fields.len() as u8);
        for &(number, value) in fields {
            definition.extend([number, value.size() as u8, value.base_type()]);
        }
        if self.defined[usize::from(local)] != definition {
            self.data.extend(&definition);
            self.defined[usize::from(local)] = definition;
        }
        self.data.push(local);
        for &(_, value) in fields {
            match value {
                Enum(v) => self.data.push(v),
                U16(v) => self.data.extend(v.to_le_bytes()),
                U32(v) | U32z(v) => self.data.extend(v.to_le_bytes()),
                I32(v) => self.data.extend(v.to_le_bytes()),
                Str(text) => self.data.extend(text.bytes().chain([0])),
            }
        }
    }

    /// The file: the 14-byte header (protocol 1.0, profile 21.00) with its CRC, the messages, their CRC.
    fn finish(self) -> Vec<u8> {
        let mut file = vec![14, 0x10];
        file.extend(2100u16.to_le_bytes());
        file.extend((self.data.len() as u32).to_le_bytes());
        file.extend(b".FIT");
        file.extend(crc(&file).to_le_bytes());
        file.extend(self.data);
        file.extend(crc(&file).to_le_bytes());
        file
    }
}

/// FIT's CRC-16 (CRC-16/ARC), four bits at a time as the protocol describes it.
fn crc(bytes: &[u8]) -> u16 {
    const TABLE: [u16; 16] = [
        0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01,
        0x8801, 0x4400,
    ];
    bytes.iter().fold(0, |mut crc, &byte| {
        for nibble in [byte & 0xF, byte >> 4] {
            crc = (crc >> 4) ^ TABLE[usize::from(crc & 0xF)] ^ TABLE[usize::from(nibble)];
        }
        crc
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::leg::distance;

    /// A message's global number, and its fields' numbers and bytes.
    type Message = (u16, Vec<(u8, Vec<u8>)>);

    /// The messages of a FIT file, after checking both CRCs.
    fn messages(file: &[u8]) -> Vec<Message> {
        assert_eq!(&file[..2], [14, 0x10]);
        assert_eq!(&file[8..12], b".FIT");
        assert_eq!(crc(&file[..14]), 0, "the header's CRC");
        assert_eq!(crc(file), 0, "the file's CRC");
        let size = u32::from_le_bytes(file[4..8].try_into().unwrap()) as usize;
        assert_eq!(file.len(), 14 + size + 2);
        let (mut data, mut out) = (&file[14..14 + size], Vec::new());
        // each local type's definition after its header: reserved, architecture, global number, fields
        let mut definitions: [&[u8]; 16] = [&[]; 16];
        while let Some((&header, rest)) = data.split_first() {
            let local = usize::from(header & 0x0F);
            if header & 0x40 != 0 {
                let length = 5 + 3 * usize::from(rest[4]);
                definitions[local] = &rest[..length];
                data = &rest[length..];
            } else {
                let definition = definitions[local];
                let mut values = Vec::new();
                let mut at = 0;
                for field in definition[5..].chunks(3) {
                    let size = usize::from(field[1]);
                    values.push((field[0], rest[at..at + size].to_vec()));
                    at += size;
                }
                out.push((u16::from_le_bytes([definition[2], definition[3]]), values));
                data = &rest[at..];
            }
        }
        out
    }

    fn unbase64(text: &str) -> Vec<u8> {
        let digits: Vec<u32> =
            text.bytes().filter(|&c| c != b'=').map(|c| BASE64.iter().position(|&d| d == c).unwrap() as u32).collect();
        let bytes = digits.chunks(4).flat_map(|chunk| {
            let n = chunk.iter().enumerate().fold(0, |n, (i, &digit)| n | digit << (18 - 6 * i));
            (0..chunk.len() - 1).map(move |i| (n >> (16 - 8 * i)) as u8)
        });
        bytes.collect()
    }

    /// The parts of a `course_fits` answer: name and FIT file.
    fn answer_parts(body: &str, created: SystemTime) -> Result<Vec<(String, Vec<u8>)>, String> {
        let answer = Json::parse(&course_fits(body, created)?).unwrap();
        let parts = answer.get("parts").and_then(Json::array).unwrap();
        let text = |part: &Json, key: &str| part.get(key).and_then(Json::str).unwrap().to_string();
        Ok(parts.iter().map(|part| (text(part, "name"), unbase64(&text(part, "fit")))).collect())
    }

    #[test]
    fn base64_is_rfc_4648_with_padding() {
        for (bytes, text) in
            [(&b""[..], ""), (b"M", "TQ=="), (b"Ma", "TWE="), (b"Man", "TWFu"), (&[0xFB, 0xFF], "+/8=")]
        {
            let mut out = String::new();
            push_base64(&mut out, bytes);
            assert_eq!(out, text);
            assert_eq!(unbase64(text), bytes);
        }
    }

    fn field(message: &[(u8, Vec<u8>)], number: u8) -> u64 {
        let bytes = &message.iter().find(|(n, _)| *n == number).unwrap().1;
        bytes.iter().rev().fold(0, |value, &byte| value << 8 | u64::from(byte))
    }

    #[test]
    fn courses_made_in_the_same_second_differ_in_their_serial_number() {
        let created = UNIX_EPOCH + Duration::from_secs(FIT_EPOCH + 1_000_000);
        let serial = |json: &str| field(&messages(&Course::parse(json).unwrap().fit(created))[0].1, 3);
        let a = serial(r#"{"name": "A", "coordinates": [[15.0, 47.0], [15.001, 47.0]]}"#);
        let b = serial(r#"{"name": "A", "coordinates": [[15.0, 47.0], [15.002, 47.0]]}"#);
        assert_ne!(a, b);
        assert_ne!(a, 0, "0 is no value");
    }

    #[test]
    fn crc_is_crc16_arc() {
        assert_eq!(crc(b"123456789"), 0xBB3D);
        assert_eq!(crc(b""), 0);
    }

    #[test]
    fn courses_go_out_as_fit_messages() {
        let course = Course::parse(
            r#"{"name": "Graz → Weiz", "coordinates": [[15.0, 47.0, 300], [15.001, 47.0], [15.001, 47.001, 310.5]]}"#,
        )
        .unwrap();
        let created = UNIX_EPOCH + Duration::from_secs(FIT_EPOCH + 1_000_000);
        let messages = messages(&course.fit(created));
        let globals: Vec<u16> = messages.iter().map(|(global, _)| *global).collect();
        assert_eq!(globals, [0, 31, 19, 21, 20, 20, 20, 21], "file_id, course, lap, start, records, stop");
        let file_id = &messages[0].1;
        assert_eq!((field(file_id, 0), field(file_id, 1), field(file_id, 4)), (6, 255, 1_000_000));
        assert_eq!(messages[1].1[0], (5, b"Graz \xE2\x86\x92 Weiz\0".to_vec()));
        assert_eq!(field(&messages[1].1, 4), 2, "cycling");

        let records = &messages[4..7];
        let along = [0.0, distance([15.0, 47.0], [15.001, 47.0])];
        let along = [along[0], along[1], along[1] + distance([15.001, 47.0], [15.001, 47.001])];
        for ((_, record), meters) in records.iter().zip(along) {
            assert_eq!(field(record, 253), 1_000_000 + (meters / SPEED).round() as u64);
            assert_eq!(field(record, 5), (meters * 100.0).round() as u64);
        }
        assert_eq!(field(&records[2].1, 0) as u32 as i32, semicircles(47.001));
        assert_eq!(semicircles(47.001), 560_743_772);
        assert_eq!(field(&records[2].1, 1) as u32 as i32, semicircles(15.001));
        let heights: Vec<u64> = records.iter().map(|(_, r)| field(r, 2)).collect();
        let middle = 300.0 + 10.5 * along[1] / along[2];
        assert_eq!(heights, [4000, ((middle + 500.0) * 5.0).round() as u64, 4053], "scale 5, offset 500");

        let lap = &messages[2].1;
        assert_eq!(field(lap, 9), (along[2] * 100.0).round() as u64);
        assert_eq!((field(lap, 21), field(lap, 22)), (11, 0), "10.5 m: climbing past 5 m counts");
        assert_eq!(field(lap, 7), (field(&records[2].1, 253) - 1_000_000) * 1000);
        assert_eq!((field(&messages[3].1, 1), field(&messages[7].1, 1)), (0, 9), "timer start, stop_disable_all");
    }

    #[test]
    fn courses_without_heights_have_no_altitude() {
        let course = Course::parse(r#"{"coordinates": [[15, 47, null], [15, 47]]}"#).unwrap();
        let messages = messages(&course.fit(UNIX_EPOCH));
        assert_eq!(messages[1].1[0].1, b"RichiRoute\0");
        let records: Vec<_> = messages.iter().filter(|(global, _)| *global == 20).collect();
        assert_eq!(records.len(), 2, "the ends stay");
        assert!(records.iter().all(|(_, r)| r.iter().all(|(n, _)| *n != 2)));
        assert!(field(&records[1].1, 253) > field(&records[0].1, 253), "times increase even standing still");
        for bad in [
            r#"{"coordinates": [[15, 47]]}"#,
            r#"{"coordinates": [[15, 47], [15, 91]]}"#,
            r#"{"coordinates": [[15, 47], [15, 47, "300"]]}"#,
            r#"{"name": 1, "coordinates": [[15, 47], [15, 47]]}"#,
        ] {
            assert!(Course::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn missing_heights_come_from_the_known_ones_along_the_way() {
        let along = [0.0, 10.0, 10.0, 30.0, 50.0, 60.0];
        let filled = fill_heights(&[None, Some(100.0), Some(90.0), None, Some(130.0), None], &along).unwrap();
        assert_eq!(filled, [100.0, 100.0, 90.0, 110.0, 130.0, 130.0], "a point where the last one was keeps its own");
        assert_eq!(fill_heights(&[None, None], &along[..2]), None);
    }

    /// A course straight north from 40° N, a point every 500 m climbing 0.5 m, with stops at these meters.
    fn line(meters: f64, stops: &[f64]) -> Course {
        let points = (meters / 500.0).round() as usize;
        let degrees = 500.0 / (6_371_008.8 * std::f64::consts::PI / 180.0);
        Course {
            name: "Wien → Bregenz".into(),
            coordinates: (0..=points).map(|i| [15.0, 40.0 + i as f64 * degrees]).collect(),
            elevations: (0..=points).map(|i| Some(i as f64 * 0.5)).collect(),
            stops: stops.iter().map(|meters| (meters / 500.0).round() as usize).collect(),
        }
    }

    fn length(course: &Course) -> f64 {
        *along(&course.coordinates).last().unwrap()
    }

    /// The meters along the whole course where its parts begin, after the first.
    fn cut_at(course: Course) -> Vec<f64> {
        let parts = course.split();
        parts[..parts.len() - 1]
            .iter()
            .scan(0.0, |meters, part| {
                *meters += length(part);
                Some(meters.round())
            })
            .collect()
    }

    #[test]
    fn courses_up_to_the_limit_stay_one_file_as_before() {
        let created = UNIX_EPOCH + Duration::from_secs(FIT_EPOCH + 1_000_000);
        let course = line(MAX_COURSE_METERS, &[200_000.0]);
        assert!((length(&course) - MAX_COURSE_METERS).abs() < 1.0);
        let points: Vec<String> = course.coordinates.iter().map(|[lon, lat]| format!("[{lon},{lat},300]")).collect();
        let body = format!(r#"{{"name": "Wien → Bregenz", "coordinates": [{}]}}"#, points.join(","));
        let alone = vec![("Wien → Bregenz".to_string(), Course::parse(&body).unwrap().fit(created))];
        assert_eq!(answer_parts(&body, created).unwrap(), alone);
        let with_stops = body.replace(r#""coordinates""#, r#""stops": [400], "coordinates""#);
        assert_eq!(answer_parts(&with_stops, created).unwrap(), alone, "byte for byte");
    }

    #[test]
    fn longer_courses_go_out_in_the_fewest_even_parts_that_join() {
        for km in [401.0, 756.0, 799.0, 1_201.0, 1_990.0] {
            let course = line(km * 1000.0, &[]);
            let (total, ascent) = (length(&course), course.elevations.last().unwrap().unwrap());
            let parts = course.split();
            let count = (km / 400.0).ceil() as usize;
            assert_eq!(parts.len(), count, "{km} km: {:?}", parts.iter().map(length).collect::<Vec<_>>());
            for (i, part) in parts.iter().enumerate() {
                assert_eq!(part.name, format!("Wien → Bregenz (Teil {}/{count})", i + 1));
                assert!(length(part) <= MAX_COURSE_METERS, "{km} km: {}", length(part));
                assert!((length(part) - total / count as f64).abs() <= 500.0, "{km} km: {}", length(part));
            }
            for pair in parts.windows(2) {
                assert_eq!(pair[0].coordinates.last(), pair[1].coordinates.first());
                assert_eq!(pair[0].elevations.last(), pair[1].elevations.first());
            }
            assert!((parts.iter().map(length).sum::<f64>() - total).abs() < 0.01);
            let climbed: f64 =
                parts.iter().map(|part| part.elevations.last().unwrap().unwrap() - part.elevations[0].unwrap()).sum();
            assert!((climbed - ascent).abs() < 1e-9);
        }
    }

    #[test]
    fn a_stop_near_the_even_cut_takes_its_place() {
        assert_eq!(cut_at(line(756_000.0, &[])), [378_000.0]);
        assert_eq!(cut_at(line(756_000.0, &[100_000.0, 360_000.0, 700_000.0])), [360_000.0]);
        assert_eq!(cut_at(line(756_000.0, &[350_000.0, 370_000.0, 390_000.0])), [370_000.0], "the nearest");
        assert_eq!(cut_at(line(756_000.0, &[300_000.0, 401_000.0])), [378_000.0], "too far, or a part too long");
        assert_eq!(cut_at(line(756_000.0, &[355_000.0])), [378_000.0], "the rest would be too long");
        // the rest is shared evenly again after a stop
        assert_eq!(cut_at(line(1_100_000.0, &[340_000.0])), [340_000.0, 720_000.0]);
    }

    #[test]
    fn parts_get_their_heights_from_the_whole_route_and_names_of_their_own() {
        let mut course = line(790_000.0, &[]);
        course.name = "x".repeat(70);
        let middle = course.elevations.len() / 2;
        course.elevations[middle - 5..middle + 5].fill(None);
        let parts = course.split();
        assert!((parts[1].elevations[0].unwrap() - middle as f64 * 0.5).abs() < 1e-9);
        assert_eq!(parts[0].name, format!("{} (Teil 1/2)", "x".repeat(53)));
        let created = UNIX_EPOCH + Duration::from_secs(FIT_EPOCH + 1_000_000);
        let fits: Vec<Vec<Message>> = parts.iter().map(|part| messages(&part.fit(created))).collect();
        assert_ne!(field(&fits[0][0].1, 3), field(&fits[1][0].1, 3), "a serial number each");
        assert_eq!(fits[1][1].1[0].1, format!("{} (Teil 2/2)\0", "x".repeat(53)).into_bytes());
    }

    #[test]
    fn every_part_comes_in_one_answer() {
        let points: Vec<String> = (0..=9).map(|i| format!("[15, {}]", 40 + i)).collect();
        let body = format!(r#"{{"name": "Nord", "stops": [4], "coordinates": [{}]}}"#, points.join(","));
        let created = UNIX_EPOCH;
        let parts = Course::parse(&body).unwrap().split();
        assert_eq!(parts.iter().map(|part| part.coordinates.len()).collect::<Vec<_>>(), [4, 4, 4]);
        let expected: Vec<_> = parts.iter().map(|part| (part.name.clone(), part.fit(created))).collect();
        assert_eq!(answer_parts(&body, created).unwrap(), expected);
        assert_eq!(expected[2].0, "Nord (Teil 3/3)");
        for bad in [r#""stops": [9.5]"#, r#""stops": [10]"#, r#""stops": 4"#] {
            assert!(course_fits(&body.replace(r#""stops": [4]"#, bad), created).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_segment_longer_than_a_part_still_ends_the_split() {
        // the route's points are 445 km apart: no cut keeps the parts within the limit, but each has a length
        let course = Course::parse(r#"{"coordinates": [[15, 40], [15, 40.001], [15, 44], [15, 48]]}"#).unwrap();
        let parts = course.split();
        assert!(parts.iter().all(|part| part.coordinates.len() >= 2 && length(part) > 0.0));
        assert_eq!(parts.last().unwrap().coordinates.last(), Some(&[15.0, 48.0]));
    }

    #[test]
    fn thinning_keeps_the_ends_turns_and_heights_within_tolerance() {
        // 2 km east with a wobble, a 300 m spur out and back to the north, a climb and a wiggle in height
        let mut coordinates = Vec::new();
        let mut heights = Vec::new();
        for i in 0..=400 {
            let x = f64::from(i) * 5.0;
            coordinates.push([15.0 + x / 76_000.0, 47.0 + (x / 40.0).sin() * 1.5 / 111_195.0]);
            heights.push(300.0 + if x > 1_000.0 { (x - 1_000.0) * 0.05 } else { 0.0 } + (x / 7.0).sin() * 0.4);
        }
        let turn = coordinates.len() + 60;
        for i in (1..=60).chain((0..60).rev()) {
            coordinates.push([coordinates[400][0], coordinates[400][1] + f64::from(i) * 5.0 / 111_195.0]);
            heights.push(heights[400]);
        }
        let mut along = vec![0.0];
        for step in coordinates.windows(2) {
            along.push(along.last().unwrap() + distance(step[0], step[1]));
        }
        let kept = thin(&coordinates, Some(&heights), &along);
        assert_eq!((kept[0], *kept.last().unwrap()), (0, coordinates.len() - 1));
        assert!(kept.contains(&(turn - 1)), "the spur's end: {kept:?}");
        assert!(kept.len() < coordinates.len() / 10, "{} of {}", kept.len(), coordinates.len());
        let meters_per_degree = 6_371_008.8 * std::f64::consts::PI / 180.0;
        let plane = |c: Coord| [c[0] * meters_per_degree * 47.0f64.to_radians().cos(), c[1] * meters_per_degree];
        for pair in kept.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            for i in a + 1..b {
                let off = off_segment(plane(coordinates[i]), plane(coordinates[a]), plane(coordinates[b]));
                assert!(off <= SIDEWAYS + 0.01, "{i} is {off} m off");
                let share = (along[i] - along[a]) / (along[b] - along[a]);
                assert!((heights[i] - heights[a] - (heights[b] - heights[a]) * share).abs() <= HEIGHT);
            }
        }
    }

    #[test]
    fn thinning_keeps_the_top_of_every_climb() {
        // without it, the top would go: it lies within `HEIGHT` of the line from 9 m to 8.5 m
        let coordinates: Vec<Coord> = (0..7).map(|i| [15.0 + f64::from(i) * 1e-4, 47.0]).collect();
        let heights = [0.0, 3.0, 6.0, 9.0, 9.3, 8.5, 4.0];
        let along: Vec<f64> = (0..7).map(|i| f64::from(i) * 7.6).collect();
        assert_eq!(climb_turns(&heights), [0, 4]);
        let kept = thin(&coordinates, Some(&heights), &along);
        assert!(kept.contains(&4), "{kept:?}");
        assert_eq!(ascent(&kept.iter().map(|&i| heights[i]).collect::<Vec<_>>()), 9.3);
    }
}

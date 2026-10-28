//! The rider's surface corrections (`config/surface-corrections.json`, prepared by
//! `src/domain/surface-corrections.ts`): a corrected piece of a way is routed and reported as if OSM had
//! the corrected tags, and its way tags name what OSM says as `osm:<key>=<value>`.
//!
//! The prepared file: a `richiroute-surfaces 1` header, then one correction per line, tab-separated:
//! the OSM surfaces it was reported over (comma-separated, empty for none), its edits
//! (`;`-separated `key only value`: `only` lists the replaced values with `|` or is `*`, a value of
//! `-` removes the tag), and its points (`ilon,ilat` separated by spaces). A piece of a link (between
//! consecutive points of its geometry) is corrected when it joins two consecutive points of a
//! correction; where OSM has since changed the surface, the correction lapses.

use std::collections::HashMap;
use std::fmt::Write;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use brouter_expressions::ExpressionContext;
use brouter_mapaccess::Pos;
use brouter_util::FxBuildHasher;

#[derive(Debug, Default)]
pub struct SurfaceCorrections {
    pieces: HashMap<(Pos, Pos), usize, FxBuildHasher>,
    corrections: Vec<Correction>,
    cells: Cells,
}

#[derive(Debug)]
struct Correction {
    osm_surfaces: Vec<String>,
    edits: Vec<Edit>,
}

#[derive(Debug)]
struct Edit {
    key: String,
    only: Vec<String>,
    value: String,
}

/// A corrected way description and the `osm:` tags of what it changed (each after a space).
pub(crate) struct Corrected {
    pub description: Vec<u8>,
    pub osm_tags: String,
}

/// The corrections along one link: for each of its pieces, the index of its corrected description.
pub(crate) struct Along {
    pieces: Vec<Option<usize>>,
    pub corrected: Vec<Arc<Corrected>>,
}

/// A request's corrected descriptions, by correction and way description: a search passes the same links
/// again and again.
pub(crate) type SurfaceMemo = HashMap<usize, HashMap<Box<[u8]>, Option<Arc<Corrected>>, FxBuildHasher>, FxBuildHasher>;

impl Along {
    pub fn piece(&self, n: usize) -> Option<usize> {
        self.pieces.get(n).copied().flatten()
    }
}

/// The cells (2^12 micro-degrees, about 300 m) that hold corrected points, as bits over their bounding
/// box: most pieces a search looks at are ruled out without hashing.
#[derive(Debug, Default)]
struct Cells {
    west: i32,
    south: i32,
    width: i32,
    height: i32,
    bits: Vec<u64>,
}

impl Cells {
    const SHIFT: u32 = 12;

    fn new(points: &[Pos]) -> Self {
        let cells: Vec<_> = points.iter().map(|p| (p.ilon >> Self::SHIFT, p.ilat >> Self::SHIFT)).collect();
        let (Some(west), Some(south)) = (cells.iter().map(|c| c.0).min(), cells.iter().map(|c| c.1).min()) else {
            return Self::default();
        };
        let width = cells.iter().map(|c| c.0).max().unwrap_or(west) - west + 1;
        let height = cells.iter().map(|c| c.1).max().unwrap_or(south) - south + 1;
        let mut map =
            Self { west, south, width, height, bits: vec![0; (width as usize * height as usize).div_ceil(64)] };
        for (x, y) in cells {
            let i = ((y - south) * width + x - west) as usize;
            map.bits[i / 64] |= 1 << (i % 64);
        }
        map
    }

    fn contains(&self, p: Pos) -> bool {
        let (x, y) = ((p.ilon >> Self::SHIFT) - self.west, (p.ilat >> Self::SHIFT) - self.south);
        if x < 0 || y < 0 || x >= self.width || y >= self.height {
            return false;
        }
        let i = (y * self.width + x) as usize;
        self.bits[i / 64] & 1 << (i % 64) != 0
    }
}

fn ordered(a: Pos, b: Pos) -> (Pos, Pos) {
    if (a.ilon, a.ilat) <= (b.ilon, b.ilat) { (a, b) } else { (b, a) }
}

impl SurfaceCorrections {
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut lines = text.lines();
        if lines.next() != Some("richiroute-surfaces\t1") {
            return Err("not a prepared surface corrections file".into());
        }
        let (mut corrections, mut all) = (Self::default(), Vec::new());
        for (n, line) in lines.enumerate() {
            let invalid = || format!("surface corrections line {}: invalid", n + 2);
            let [osm, edits, points] = line.split('\t').collect::<Vec<_>>()[..] else { return Err(invalid()) };
            let edits = edits
                .split(';')
                .map(|edit| match edit.split(' ').collect::<Vec<_>>()[..] {
                    [key, only, value] => Some(Edit {
                        key: key.into(),
                        only: if only == "*" { Vec::new() } else { only.split('|').map(Into::into).collect() },
                        value: if value == "-" { String::new() } else { value.into() },
                    }),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()
                .ok_or_else(invalid)?;
            let points = points
                .split(' ')
                .map(|point| {
                    let (ilon, ilat) = point.split_once(',')?;
                    Some(Pos::new(ilon.parse().ok()?, ilat.parse().ok()?))
                })
                .collect::<Option<Vec<_>>>()
                .filter(|points| points.len() >= 2)
                .ok_or_else(invalid)?;
            let index = corrections.corrections.len();
            for pair in points.windows(2) {
                corrections.pieces.insert(ordered(pair[0], pair[1]), index);
            }
            all.extend(points);
            corrections.corrections.push(Correction { osm_surfaces: osm.split(',').map(Into::into).collect(), edits });
        }
        corrections.cells = Cells::new(&all);
        Ok(corrections)
    }

    pub fn len(&self) -> usize {
        self.corrections.len()
    }

    pub fn is_empty(&self) -> bool {
        self.corrections.is_empty()
    }

    fn piece(&self, a: Pos, b: Pos) -> Option<usize> {
        if !self.cells.contains(a) {
            return None;
        }
        self.pieces.get(&ordered(a, b)).copied()
    }

    /// The corrections along the link through `points` with the way `description`, if a piece of it
    /// is corrected.
    pub(crate) fn along(
        &self,
        ctx: &ExpressionContext,
        description: &[u8],
        points: impl Iterator<Item = Pos>,
        memo: &mut SurfaceMemo,
    ) -> Option<Along> {
        let mut found: Option<Vec<Option<usize>>> = None;
        let mut previous = None;
        for (n, point) in points.enumerate() {
            let Some(a) = previous.replace(point) else { continue };
            let correction = self.piece(a, point);
            if correction.is_some() || found.is_some() {
                found.get_or_insert_with(|| vec![None; n - 1]).push(correction);
            }
        }
        // the corrected description of each correction, if it still applies and changes a tag
        let (mut tried, mut corrected) = (Vec::<(usize, Option<usize>)>::new(), Vec::new());
        let mut pieces = found?;
        for piece in &mut pieces {
            let Some(correction) = *piece else { continue };
            *piece = match tried.iter().find(|(c, _)| *c == correction) {
                Some(&(_, index)) => index,
                None => {
                    let known = memo.entry(correction).or_default();
                    let result = match known.get(description) {
                        Some(result) => result.clone(),
                        None => {
                            let result = self.correct(ctx, correction, description).map(Arc::new);
                            known.insert(description.into(), result.clone());
                            result
                        }
                    };
                    let index = result.map(|c| {
                        corrected.push(c);
                        corrected.len() - 1
                    });
                    tried.push((correction, index));
                    index
                }
            };
        }
        (!corrected.is_empty()).then_some(Along { pieces, corrected })
    }

    fn correct(&self, ctx: &ExpressionContext, correction: usize, description: &[u8]) -> Option<Corrected> {
        let correction = &self.corrections[correction];
        let mut ld = ctx.create_new_lookup_data()?;
        ctx.decode_into(&mut ld, false, description);
        let surface = usize::try_from(ctx.lookup_key("surface")).ok()?;
        let osm_surface = value_name(ctx, &ld, surface)?;
        if !correction.osm_surfaces.iter().any(|s| s == osm_surface) {
            return None;
        }
        let mut osm_tags = String::new();
        for edit in &correction.edits {
            let Ok(key) = usize::try_from(ctx.lookup_key(&edit.key)) else { continue };
            let Some(old) = value_name(ctx, &ld, key) else { continue };
            let replaced = if edit.value.is_empty() { 0 } else { ctx.get_lookup_value_idx(key, &edit.value) };
            if replaced < 0 || replaced == ld[key] || (!edit.only.is_empty() && !edit.only.iter().any(|v| v == old)) {
                continue;
            }
            let _ = write!(osm_tags, " osm:{}={old}", edit.key);
            ld[key] = replaced;
        }
        if osm_tags.is_empty() {
            return None;
        }
        Some(Corrected { description: ctx.encode(&ld)?, osm_tags })
    }
}

/// The name of the key's value; numbers (1000 and above) have none.
fn value_name<'a>(ctx: &'a ExpressionContext, ld: &[i32], key: usize) -> Option<&'a str> {
    Some(ctx.lookup_value_name(key, usize::try_from(ld[key]).ok().filter(|&v| v < 1000)?))
}

/// The prepared corrections file, read again once it changes. Without the file there are none.
pub struct SurfaceFile {
    path: PathBuf,
    loaded: Mutex<(Stamp, Arc<SurfaceCorrections>)>,
}

/// What tells one version of the file from the next: a rewrite within one timestamp tick still changes its size,
/// or, renamed into place, the file itself.
type Stamp = Option<(SystemTime, u64, u64)>;

fn stamp(path: &Path) -> Stamp {
    let metadata = fs::metadata(path).ok()?;
    #[cfg(unix)]
    let file = std::os::unix::fs::MetadataExt::ino(&metadata);
    #[cfg(not(unix))]
    let file = 0;
    Some((metadata.modified().ok()?, metadata.len(), file))
}

impl SurfaceFile {
    pub fn open(path: &Path) -> Result<Self, String> {
        Ok(Self { path: path.into(), loaded: Mutex::new(read(path)?) })
    }

    /// The corrections as the file now has them. A file that turns invalid keeps the last valid ones.
    pub fn current(&self) -> Arc<SurfaceCorrections> {
        let mut loaded = self.loaded.lock().unwrap_or_else(PoisonError::into_inner);
        let current = stamp(&self.path);
        if current != loaded.0 {
            match read(&self.path) {
                Ok(read) => *loaded = read,
                Err(e) => {
                    eprintln!("{e}");
                    loaded.0 = current;
                }
            }
        }
        loaded.1.clone()
    }
}

fn read(path: &Path) -> Result<(Stamp, Arc<SurfaceCorrections>), String> {
    let Some(stamp) = stamp(path) else { return Ok((None, Arc::default())) };
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok((Some(stamp), Arc::new(SurfaceCorrections::parse(&text)?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_corrections_and_rejects_malformed_lines() {
        let text = "richiroute-surfaces\t1\n,gravel\tsurface * paved;smoothness * -\t1,2 3,4 5,6\n";
        let corrections = SurfaceCorrections::parse(text).unwrap();
        assert_eq!(corrections.len(), 1);
        assert_eq!(corrections.corrections[0].osm_surfaces, ["", "gravel"]);
        assert_eq!(corrections.corrections[0].edits[1].value, "");
        assert!(corrections.corrections[0].edits[0].only.is_empty());
        assert_eq!(corrections.piece(Pos::new(5, 6), Pos::new(3, 4)), Some(0));
        assert_eq!(corrections.piece(Pos::new(1, 2), Pos::new(5, 6)), None);
        assert!(corrections.cells.contains(Pos::new(4095, 4095)));
        assert!(!corrections.cells.contains(Pos::new(4096, 2)) && !corrections.cells.contains(Pos::new(-1, 2)));
        assert!(SurfaceCorrections::parse("").is_err());
        for line in ["\tsurface * paved\t1,2", "\tsurface paved\t1,2 3,4", "\tsurface * paved\t1,2 3", "x\ty"] {
            assert!(SurfaceCorrections::parse(&format!("richiroute-surfaces\t1\n{line}\n")).is_err(), "{line}");
        }
    }

    #[test]
    fn reads_the_file_again_once_it_changes() {
        let path = std::env::temp_dir().join(format!("richi-surface-file-{}.tsv", std::process::id()));
        let write = |text: &str, seconds: u64| {
            fs::write(&path, text).unwrap();
            let modified = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(seconds);
            fs::File::options().write(true).open(&path).unwrap().set_modified(modified).unwrap();
        };
        let file = SurfaceFile::open(&path).unwrap();
        assert!(file.current().is_empty());
        let one = "richiroute-surfaces\t1\n\tsurface * paved\t1,2 3,4\n";
        write(one, 1);
        assert_eq!(file.current().len(), 1);
        write("broken", 2);
        assert_eq!(file.current().len(), 1, "the last valid corrections stay");
        write(&format!("{one}\tsurface * paved\t3,4 5,6\n"), 3);
        assert_eq!(file.current().len(), 2);
        // rewritten within the same timestamp
        write(&format!("{one}\tsurface * paved\t3,4 5,6\n\tsurface * paved\t5,6 7,8\n"), 3);
        assert_eq!(file.current().len(), 3);
        fs::remove_file(&path).unwrap();
        assert!(file.current().is_empty());
    }
}

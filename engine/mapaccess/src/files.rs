//! Ports of `PhysicalFile` (an open `.rd5` segment file covering 5x5 degrees) and `OsmFile` (one degree
//! square of it, split into cells that are read and decoded on demand).

use crate::OsmNodesMap;
use crate::direct_weaver::{DecodedCell, WeaveBuffers, weave};
use crate::store::{CellKey, SegmentStore};
use brouter_codec::{DataBuffers, MicroCache, StatCoderContext, TagValueValidator, WaypointMatcher};
use brouter_util::{ByteDataReader, crc};
use std::fs::File;
use std::io;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::SystemTime;

/// An `IOException` message, wrapped by `NodesCache` into the error the router reports.
pub(crate) type IoResult<T> = Result<T, String>;

fn io_message(e: io::Error) -> String {
    e.to_string()
}

/// Reads `buf.len()` bytes at `pos` without moving a shared file position, so threads can share the
/// file (Java seeks its own `RandomAccessFile`).
fn read_fully(file: &File, pos: u64, buf: &mut [u8]) -> IoResult<()> {
    #[cfg(unix)]
    let result = std::os::unix::fs::FileExt::read_exact_at(file, buf, pos);
    #[cfg(windows)]
    let result = (|| {
        let mut done = 0;
        while done < buf.len() {
            match std::os::windows::fs::FileExt::seek_read(file, &mut buf[done..], pos + done as u64)? {
                0 => return Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
                n => done += n,
            }
        }
        Ok(())
    })();
    #[cfg(not(any(unix, windows)))]
    let result = {
        use std::io::{Read, Seek, SeekFrom};
        // without positional reads, one file position for all threads
        static POSITION: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = POSITION.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut f = file;
        f.seek(SeekFrom::Start(pos)).and_then(|_| f.read_exact(buf))
    };
    result.map_err(io_message)
}

/// What identifies the file on disk behind an open `PhysicalFile`: if it changes, the file was
/// replaced and is opened again.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
    /// Device and inode, where the platform has them.
    id: (u64, u64),
}

impl FileStamp {
    pub(crate) fn of(meta: &std::fs::Metadata) -> Self {
        #[cfg(unix)]
        let id = (std::os::unix::fs::MetadataExt::dev(meta), std::os::unix::fs::MetadataExt::ino(meta));
        #[cfg(not(unix))]
        let id = (0, 0);
        Self { len: meta.len(), modified: meta.modified().ok(), id }
    }
}

pub(crate) struct PhysicalFile {
    ra: File,
    file_name: String,
    /// Distinguishes this open file from earlier versions in the store's cell cache.
    pub(crate) id: u64,
    pub(crate) stamp: FileStamp,
    /// The lookup table version the file was built with.
    read_version: i16,
    file_index: [i64; 25],
    file_header_crcs: Option<[i32; 25]>,
    divisor: i32,
    elevation_type: i8,
    /// Each tile's cell index (`OsmFile.posIdx`), read and checked on first use.
    pos_idx: [OnceLock<Arc<[i32]>>; 25],
}

impl PhysicalFile {
    /// Opens a segment file and reads its index; Java's `lookupMinorVersion` argument is unused there.
    pub(crate) fn open(f: &Path, lookup_version: i32, id: u64) -> IoResult<Self> {
        let ra = File::open(f).map_err(io_message)?;
        // Java reads both the header and the trailer into DataBuffers.iobuffer; a trailer without
        // the elevation byte leaves the header's byte 112 in its place.
        let mut iobuffer = [0u8; 200];
        read_fully(&ra, 0, &mut iobuffer)?;
        let file_index_crc = crc(&iobuffer, 0, 200);
        let mut dis = ByteDataReader::new(&iobuffer);
        let longs: [i64; 25] = std::array::from_fn(|_| dis.read_long());
        let meta = ra.metadata().map_err(io_message)?;
        let mut pf = Self {
            ra,
            file_name: f.file_name().unwrap_or_default().to_string_lossy().into_owned(),
            id,
            stamp: FileStamp::of(&meta),
            read_version: (longs[0] >> 48) as i16,
            file_index: longs.map(|lv| lv & 0xffff_ffff_ffff),
            file_header_crcs: None,
            divisor: 80,
            elevation_type: 3,
            pos_idx: Default::default(),
        };
        pf.check_lookup_version(lookup_version)?;

        // read some extra info from the end of the file, if present
        let file_index = pf.file_index;
        let len = meta.len() as i64;
        let pos = file_index[24];
        let mut extra_len = 8 + 26 * 4;

        if len == pos {
            return Ok(pf); // old format o.k.
        }
        if len - pos > extra_len {
            extra_len += 1;
        }
        if len < pos + extra_len {
            // > is o.k. for future extensions!
            return Err(format!("file of size {len} too short, should be {}", pos + extra_len));
        }

        read_fully(&pf.ra, pos as u64, &mut iobuffer[..extra_len as usize])?;
        let mut dis = ByteDataReader::new(&iobuffer);
        let _creation_time = dis.read_long();

        let crc_data = dis.read_int();
        if crc_data == file_index_crc {
            pf.divisor = 80; // old format
        } else if (crc_data ^ 2) == file_index_crc {
            pf.divisor = 32; // new format
        } else {
            return Err("top index checksum error".into());
        }
        let mut crcs = [0i32; 25];
        for c in &mut crcs {
            *c = dis.read_int();
        }
        pf.file_header_crcs = Some(crcs);
        pf.elevation_type = dis.read_byte();
        Ok(pf)
    }

    /// The check `open` makes after reading the index, also for a file opened by an earlier search.
    pub(crate) fn check_lookup_version(&self, lookup_version: i32) -> IoResult<()> {
        if lookup_version != -1 && i32::from(self.read_version) != lookup_version {
            let (file_name, read_version) = (&self.file_name, self.read_version);
            return Err(format!(
                "lookup version mismatch (old rd5?) lookups.dat={lookup_version} {file_name}={read_version}"
            ));
        }
        Ok(())
    }

    /// The tile's cell index, read with the checks of Java's `OsmFile` constructor (only successes
    /// are kept, so a failing read fails again for the next search, as in Java).
    fn pos_idx(&self, tile_index: usize, file_offset: i64, ncaches: usize) -> IoResult<Arc<[i32]>> {
        if let Some(pos_idx) = self.pos_idx[tile_index].get() {
            return Ok(pos_idx.clone());
        }
        let indexsize = ncaches * 4;
        let mut iobuffer = vec![0u8; indexsize];
        read_fully(&self.ra, file_offset as u64, &mut iobuffer)?;

        if let Some(crcs) = &self.file_header_crcs {
            let header_crc = crc(&iobuffer, 0, indexsize);
            if crcs[tile_index] != header_crc {
                return Err("sub index checksum error".into());
            }
        }

        let mut dis = ByteDataReader::new(&iobuffer);
        let pos_idx: Arc<[i32]> = (0..ncaches).map(|_| dis.read_int()).collect();
        Ok(self.pos_idx[tile_index].get_or_init(|| pos_idx).clone())
    }
}

pub(crate) struct OsmFile {
    is: Option<Arc<PhysicalFile>>,
    tile_index: usize,
    file_offset: i64,
    pos_idx: Arc<[i32]>,
    /// `None` when the square has no data (`hasData()`). Boxed: most slots stay empty, and a loaded
    /// one holds just a marker under direct weaving.
    micro_caches: Option<Vec<Option<Box<MicroCache>>>>,
    pub(crate) lon_degree: i32,
    lat_degree: i32,
    divisor: i32,
    cellsize: i32,
    indexsize: i32,
    pub(crate) elevation_type: i8,
}

impl OsmFile {
    pub(crate) fn new(rafile: Option<&Arc<PhysicalFile>>, lon_degree: i32, lat_degree: i32) -> IoResult<Self> {
        let lon_mod5 = lon_degree % 5;
        let lat_mod5 = lat_degree % 5;
        let tile_index = (lon_mod5 * 5 + lat_mod5) as usize;
        let mut osmf = Self {
            is: None,
            tile_index,
            file_offset: 0,
            pos_idx: Arc::new([]),
            micro_caches: None,
            lon_degree,
            lat_degree,
            divisor: 0,
            cellsize: 0,
            indexsize: 0,
            elevation_type: 3,
        };

        let Some(rafile) = rafile else {
            return Ok(osmf);
        };
        osmf.divisor = rafile.divisor;
        osmf.elevation_type = rafile.elevation_type;

        osmf.cellsize = 1_000_000 / osmf.divisor;
        let ncaches = (osmf.divisor * osmf.divisor) as usize;
        osmf.indexsize = ncaches as i32 * 4;

        let index = &rafile.file_index;
        osmf.file_offset = if tile_index > 0 { index[tile_index - 1] } else { 200 };
        if osmf.file_offset == index[tile_index] {
            return Ok(osmf); // empty
        }

        osmf.pos_idx = rafile.pos_idx(tile_index, osmf.file_offset, ncaches)?;
        osmf.is = Some(rafile.clone());
        osmf.micro_caches = Some((0..ncaches).map(|_| None).collect());
        Ok(osmf)
    }

    pub(crate) fn has_data(&self) -> bool {
        self.micro_caches.is_some()
    }

    /// The cell index of a position (Java's `subIdx`). Out of range only near lon -180 or lat -90, where
    /// truncating division puts negative positions into degree 0; Java's array access then fails.
    pub(crate) fn sub_idx(&self, ilon: i32, ilat: i32) -> IoResult<usize> {
        let lon_idx = ilon / self.cellsize;
        let lat_idx = ilat / self.cellsize;
        let sub_idx =
            (lat_idx - self.divisor * self.lat_degree) * self.divisor + (lon_idx - self.divisor * self.lon_degree);
        let ncaches = self.divisor * self.divisor;
        if !(0..ncaches).contains(&sub_idx) {
            return Err(format!("Index {sub_idx} out of bounds for length {ncaches}"));
        }
        Ok(sub_idx as usize)
    }

    pub(crate) fn micro_cache_mut(&mut self, sub_idx: usize) -> Option<&mut MicroCache> {
        self.micro_caches.as_mut().and_then(|m| m[sub_idx].as_deref_mut())
    }

    /// Decodes the cell at this position and stores the result (`createMicroCache(ilon, ilat, ...)`).
    /// With `hollow_nodes` the cell is woven straight into the graph, from the store's decoded copy
    /// of it. Returns the cell index.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn create_micro_cache(
        &mut self,
        ilon: i32,
        ilat: i32,
        store: &SegmentStore,
        data_buffers: &mut DataBuffers,
        weave_buffers: &mut WeaveBuffers,
        way_validator: &mut dyn TagValueValidator,
        waypoint_matcher: Option<&mut dyn WaypointMatcher>,
        hollow_nodes: Option<&mut OsmNodesMap>,
    ) -> IoResult<usize> {
        let sub_idx = self.sub_idx(ilon, ilat)?;
        let lon_idx = ilon / self.cellsize;
        let lat_idx = ilat / self.cellsize;

        let segment = if self.cell_range(sub_idx).1 == 0 {
            MicroCache::empty_cache()
        } else if let Some(hollow_nodes) = hollow_nodes {
            let is = self.is.as_ref().expect("square with data");
            let key = CellKey { file: is.id, tile: self.tile_index as u32, lon_idx, lat_idx };
            let cell = store.cell(key, || {
                let ab = self.read_cell(sub_idx, &mut data_buffers.iobuffer)?;
                Ok(DecodedCell::decode(ab, lon_idx, lat_idx, self.divisor, way_validator))
            })?;
            let grown = weave(&cell, weave_buffers, way_validator, waypoint_matcher, hollow_nodes);
            store.charge(key, &cell, grown);
            MicroCache::empty_non_virgin()
        } else {
            let mut iobuffer = std::mem::take(&mut data_buffers.iobuffer);
            let segment = self.read_cell(sub_idx, &mut iobuffer).map(|ab| {
                let mut bc = StatCoderContext::new(ab);
                MicroCache::decode_v2(
                    &mut bc,
                    data_buffers,
                    lon_idx,
                    lat_idx,
                    self.divisor,
                    way_validator,
                    waypoint_matcher,
                )
            });
            data_buffers.iobuffer = iobuffer;
            segment?
        };
        self.micro_caches.as_mut().expect("square with data")[sub_idx] = Some(Box::new(segment));
        Ok(sub_idx)
    }

    /// `getDataInputForSubIdx`: the cell's bytes lie between the previous cell's end and its own.
    fn cell_range(&self, sub_idx: usize) -> (i32, usize) {
        let start_pos = if sub_idx == 0 { self.indexsize } else { self.pos_idx[sub_idx - 1] };
        (start_pos, (self.pos_idx[sub_idx] - start_pos).max(0) as usize)
    }

    /// Reads a non-empty cell into `ab` and checks its footer.
    fn read_cell<'a>(&self, sub_idx: usize, ab: &'a mut Vec<u8>) -> IoResult<&'a [u8]> {
        let (start_pos, asize) = self.cell_range(sub_idx);
        ab.resize(asize, 0);
        let is = self.is.as_ref().expect("square with data");
        read_fully(&is.ra, (self.file_offset + i64::from(start_pos)) as u64, ab)?;

        // Java checks the footer CRC after decoding, and only if the decoder did not consume exactly
        // the cell's data, so a damaged cell fails with one of these messages. Checking first gives the
        // same errors without running the decoder on damaged data, where Java throws inside the decoder
        // and this check replaces that exception, but Rust would panic. Only damaged data that decodes
        // to exactly the right length, which Java accepts, is now rejected.
        if asize < 4 {
            return Err("checkum error".into());
        }
        let crc_data = crc(ab, 0, asize - 4);
        let crc_footer = ByteDataReader::with_offset(ab, asize - 4).read_int();
        if (crc_data ^ 2) != crc_footer {
            return Err(if crc_data == crc_footer { "old, unsupported data-format" } else { "checkum error" }.into());
        }
        Ok(ab)
    }

    /// Puts the virgin caches into ghost state and drops the others; returns the ghosted data size.
    pub(crate) fn set_ghost_state(&mut self) -> i64 {
        let mut sum = 0;
        for slot in self.micro_caches.iter_mut().flatten() {
            if let Some(mc) = slot {
                if mc.virgin {
                    mc.ghost = true;
                    sum += i64::from(mc.get_data_size());
                } else {
                    *slot = None;
                }
            }
        }
        sum
    }

    pub(crate) fn collect_all(&mut self) -> i64 {
        let mut deleted = 0;
        for mc in self.micro_caches.iter_mut().flatten().flatten() {
            if !mc.ghost {
                deleted += i64::from(mc.collect(0));
            }
        }
        deleted
    }

    /// Drops the ghost caches. (Java returns a freed size here that is always 0.)
    pub(crate) fn clean_ghosts(&mut self) {
        for slot in self.micro_caches.iter_mut().flatten() {
            if slot.as_ref().is_some_and(|mc| mc.ghost) {
                *slot = None;
            }
        }
    }

    pub(crate) fn clean(&mut self, all: bool) {
        for slot in self.micro_caches.iter_mut().flatten() {
            if slot.as_ref().is_some_and(|mc| all || !mc.virgin) {
                *slot = None;
            }
        }
    }
}

//! Ports of `PhysicalFile` (an open `.rd5` segment file covering 5x5 degrees) and `OsmFile` (one degree
//! square of it, split into cells that are read and decoded on demand).

use crate::OsmNodesMap;
use crate::direct_weaver::direct_weave;
use brouter_codec::{DataBuffers, MicroCache, StatCoderContext, TagValueValidator, WaypointMatcher};
use brouter_util::{ByteDataReader, crc};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::rc::Rc;

/// An `IOException` message, wrapped by `NodesCache` into the error the router reports.
pub(crate) type IoResult<T> = Result<T, String>;

fn io_message(e: io::Error) -> String {
    e.to_string()
}

fn read_fully(file: &File, pos: u64, buf: &mut [u8]) -> IoResult<()> {
    let mut f = file;
    f.seek(SeekFrom::Start(pos)).map_err(io_message)?;
    f.read_exact(buf).map_err(io_message)
}

pub(crate) struct PhysicalFile {
    ra: Rc<File>,
    file_index: [i64; 25],
    file_header_crcs: Option<[i32; 25]>,
    divisor: i32,
    elevation_type: i8,
}

impl PhysicalFile {
    /// Opens a segment file and reads its index; Java's `lookupMinorVersion` argument is unused there.
    pub(crate) fn open(f: &Path, lookup_version: i32) -> IoResult<Self> {
        let ra = File::open(f).map_err(io_message)?;
        // Java reads both the header and the trailer into DataBuffers.iobuffer; a trailer without
        // the elevation byte leaves the header's byte 112 in its place.
        let mut iobuffer = [0u8; 200];
        read_fully(&ra, 0, &mut iobuffer)?;
        let file_index_crc = crc(&iobuffer, 0, 200);
        let mut file_index = [0i64; 25];
        let mut dis = ByteDataReader::new(&iobuffer);
        for (i, entry) in file_index.iter_mut().enumerate() {
            let lv = dis.read_long();
            let read_version = (lv >> 48) as i16;
            if i == 0 && lookup_version != -1 && i32::from(read_version) != lookup_version {
                let file_name = f.file_name().unwrap_or_default().to_string_lossy();
                return Err(format!(
                    "lookup version mismatch (old rd5?) lookups.dat={lookup_version} {file_name}={read_version}"
                ));
            }
            *entry = lv & 0xffff_ffff_ffff;
        }

        let mut pf = Self { ra: Rc::new(ra), file_index, file_header_crcs: None, divisor: 80, elevation_type: 3 };

        // read some extra info from the end of the file, if present
        let len = pf.ra.metadata().map_err(io_message)?.len() as i64;
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
}

pub(crate) struct OsmFile {
    is: Option<Rc<File>>,
    file_offset: i64,
    pos_idx: Vec<i32>,
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
    pub(crate) fn new(rafile: Option<&PhysicalFile>, lon_degree: i32, lat_degree: i32) -> IoResult<Self> {
        let mut osmf = Self {
            is: None,
            file_offset: 0,
            pos_idx: Vec::new(),
            micro_caches: None,
            lon_degree,
            lat_degree,
            divisor: 0,
            cellsize: 0,
            indexsize: 0,
            elevation_type: 3,
        };
        let lon_mod5 = lon_degree % 5;
        let lat_mod5 = lat_degree % 5;
        let tile_index = (lon_mod5 * 5 + lat_mod5) as usize;

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

        let mut iobuffer = vec![0u8; osmf.indexsize as usize];
        read_fully(&rafile.ra, osmf.file_offset as u64, &mut iobuffer)?;

        if let Some(crcs) = &rafile.file_header_crcs {
            let header_crc = crc(&iobuffer, 0, osmf.indexsize as usize);
            if crcs[tile_index] != header_crc {
                return Err("sub index checksum error".into());
            }
        }

        let mut dis = ByteDataReader::new(&iobuffer);
        osmf.pos_idx = (0..ncaches).map(|_| dis.read_int()).collect();
        osmf.is = Some(rafile.ra.clone());
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
    /// With `hollow_nodes` the cell is woven straight into the graph. Returns the cell index.
    pub(crate) fn create_micro_cache(
        &mut self,
        ilon: i32,
        ilat: i32,
        data_buffers: &mut DataBuffers,
        way_validator: &mut dyn TagValueValidator,
        waypoint_matcher: Option<&mut dyn WaypointMatcher>,
        hollow_nodes: Option<&mut OsmNodesMap>,
    ) -> IoResult<usize> {
        let sub_idx = self.sub_idx(ilon, ilat)?;
        let lon_idx = ilon / self.cellsize;
        let lat_idx = ilat / self.cellsize;

        let mut ab = std::mem::take(&mut data_buffers.iobuffer);
        let segment = self.decode_cell(
            sub_idx,
            lon_idx,
            lat_idx,
            &mut ab,
            data_buffers,
            way_validator,
            waypoint_matcher,
            hollow_nodes,
        );
        data_buffers.iobuffer = ab;
        self.micro_caches.as_mut().expect("square with data")[sub_idx] = Some(Box::new(segment?));
        Ok(sub_idx)
    }

    #[allow(clippy::too_many_arguments)]
    fn decode_cell(
        &self,
        sub_idx: usize,
        lon_idx: i32,
        lat_idx: i32,
        ab: &mut Vec<u8>,
        data_buffers: &mut DataBuffers,
        way_validator: &mut dyn TagValueValidator,
        waypoint_matcher: Option<&mut dyn WaypointMatcher>,
        hollow_nodes: Option<&mut OsmNodesMap>,
    ) -> IoResult<MicroCache> {
        // getDataInputForSubIdx: the cell's bytes lie between the previous cell's end and its own
        let start_pos = if sub_idx == 0 { self.indexsize } else { self.pos_idx[sub_idx - 1] };
        let asize = (self.pos_idx[sub_idx] - start_pos).max(0) as usize;
        if asize == 0 {
            return Ok(MicroCache::empty_cache());
        }
        ab.resize(asize, 0);
        let is = self.is.as_ref().expect("square with data");
        read_fully(is, (self.file_offset + i64::from(start_pos)) as u64, ab)?;

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

        let mut bc = StatCoderContext::new(ab);
        let segment = match hollow_nodes {
            None => MicroCache::decode_v2(
                &mut bc,
                data_buffers,
                lon_idx,
                lat_idx,
                self.divisor,
                way_validator,
                waypoint_matcher,
            ),
            Some(hollow_nodes) => {
                direct_weave(
                    &mut bc,
                    data_buffers,
                    lon_idx,
                    lat_idx,
                    self.divisor,
                    way_validator,
                    waypoint_matcher,
                    hollow_nodes,
                );
                MicroCache::empty_non_virgin()
            }
        };
        Ok(segment)
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

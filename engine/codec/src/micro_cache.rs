use crate::{
    DataBuffers, LinkedListContainer, NoisyDiffCoder, StatCoderContext, TagValueCoder, TagValueValidator,
    TagValueWrapper, WaypointMatcher,
};
use brouter_util::{ByteDataReader, ByteDataWriter};

const DELETED: i32 = i32::MIN; // the 0x80000000 flag on fapos

const fn expand_id_bits(mut id32: i32) -> i64 {
    let mut dlon = 0i32;
    let mut dlat = 0i32;
    let mut bm = 1;
    while bm < 0x8000 {
        if id32 & 1 != 0 {
            dlon |= bm;
        }
        if id32 & 2 != 0 {
            dlat |= bm;
        }
        id32 >>= 2;
        bm <<= 1;
    }
    ((dlon as i64) << 32) | dlat as i64
}

/// `expand_id_bits` of the 10-bit groups at bit 0, 10 and 20 (`DirectWeaver.id32_00/10/20`).
static ID32_TABLES: [[i64; 1024]; 3] = {
    let mut tables = [[0; 1024]; 3];
    let mut i = 0;
    while i < 1024 {
        tables[0][i] = expand_id_bits(i as i32);
        tables[1][i] = expand_id_bits((i as i32) << 10);
        tables[2][i] = expand_id_bits((i as i32) << 20);
        i += 1;
    }
    tables
};

/// Spreads a cache-internal id (interleaved lon/lat bits) into `(dlon << 32) | dlat` offsets within
/// its cell. Java computes this with a bit loop in `MicroCache2.expandId` and with these tables in
/// `DirectWeaver.expandId`; both give the same result.
pub fn expand_id32(id32: i32) -> i64 {
    ID32_TABLES[0][(id32 & 1023) as usize]
        + ID32_TABLES[1][((id32 >> 10) & 1023) as usize]
        + ID32_TABLES[2][((id32 >> 20) & 1023) as usize]
}

/// The transfer nodes of a forward link (`decodeTransferNodes` without the matcher), written to `w` as
/// `OsmLink.geometry` encodes them (lon, lat and elevation differences), or only read past.
pub fn decode_transfer_nodes(
    bc: &mut StatCoderContext,
    trans_ele_diff: &NoisyDiffCoder,
    mut w: Option<&mut ByteDataWriter>,
    (mut dlon_remaining, mut dlat_remaining): (i32, i32),
) {
    let transcount = bc.decode_var_bits();
    let mut count = transcount + 1;
    for _ in 0..transcount {
        let dlon = bc.decode_predicted_value(dlon_remaining / count);
        let dlat = bc.decode_predicted_value(dlat_remaining / count);
        dlon_remaining = dlon_remaining.wrapping_sub(dlon);
        dlat_remaining = dlat_remaining.wrapping_sub(dlat);
        count -= 1;
        let elediff = trans_ele_diff.decode_signed_value(bc);
        if let Some(w) = &mut w {
            w.write_var_length_signed(dlon);
            w.write_var_length_signed(dlat);
            w.write_var_length_signed(elediff);
        }
    }
}

/// The waypoint matcher's part of `decodeTransferNodes`, for a forward link from `(ilon, ilat)` by
/// `(dlon, dlat)` with these transfer nodes. Java feeds the matcher while it decodes them; reading the
/// bits has no other effect, so feeding it afterwards makes the same calls. (The geometry format keeps
/// differences below 2^30, more than any two positions on earth differ by.)
pub fn match_transfer_nodes(
    geometry: &[u8],
    way_tags: Option<&TagValueWrapper>,
    way_validator: &mut dyn TagValueValidator,
    waypoint_matcher: Option<&mut (dyn WaypointMatcher + '_)>,
    (ilon, ilat): (i32, i32),
    (dlon, dlat): (i32, i32),
) {
    let (Some(tags), Some(m)) = (way_tags.filter(|tags| tags.access_type >= 2), waypoint_matcher) else { return };
    let use_as_start_way = way_validator.check_start_way(&tags.data);
    if !m.start(ilon, ilat, ilon.wrapping_add(dlon), ilat.wrapping_add(dlat), use_as_start_way) {
        return;
    }
    let mut r = ByteDataReader::new(geometry);
    let (mut lon, mut lat) = (ilon, ilat);
    while r.has_more_data() {
        lon = lon.wrapping_add(r.read_var_length_signed());
        lat = lat.wrapping_add(r.read_var_length_signed());
        r.read_var_length_signed(); // elevation
        m.transfer_node(lon, lat);
    }
    m.end();
}

/// Port of `MicroCache` and its subclass `MicroCache2`: the decoded nodes of one cell of a segment
/// file, consumed node by node and garbage-collected as the router loads them. A plain `MicroCache`
/// (no cell geometry, no data) is Java's base class instance, used for empty cells and as the
/// `emptyNonVirgin` marker of cells decoded by direct weaving.
pub struct MicroCache {
    ab: Vec<u8>,
    /// Node ids, sorted; Java's `size` is their count.
    faid: Vec<i32>,
    /// End offset of each node's data in `ab`, with the `DELETED` flag once consumed.
    fapos: Vec<i32>,
    delcount: i32,
    delbytes: i32,
    /// Next power of 2 of size.
    p2size: i32,
    /// Cache control: a virgin cache can be put to ghost state for later recovery.
    pub virgin: bool,
    pub ghost: bool,
    v2: Option<CellBase>,
}

#[derive(Clone, Copy)]
struct CellBase {
    lon_base: i32,
    lat_base: i32,
    cellsize: i32,
}

impl MicroCache {
    /// `MicroCache.emptyCache()`: the cache of a cell without data.
    pub fn empty_cache() -> Self {
        Self {
            ab: Vec::new(),
            faid: Vec::new(),
            fapos: Vec::new(),
            delcount: 0,
            delbytes: 0,
            p2size: 0,
            virgin: true,
            ghost: false,
            v2: None,
        }
    }

    /// `MicroCache.emptyNonVirgin`: stands for a cell already woven into the graph. Java shares one
    /// instance; no code path changes its state, so fresh copies behave the same.
    pub fn empty_non_virgin() -> Self {
        Self { virgin: false, ..Self::empty_cache() }
    }

    /// `init(size)` for the current node count.
    fn init(&mut self) {
        let size = self.get_size();
        self.delcount = 0;
        self.delbytes = 0;
        self.p2size = 0x4000_0000;
        while self.p2size > size {
            self.p2size >>= 1;
        }
    }

    pub fn get_size(&self) -> i32 {
        self.faid.len() as i32
    }

    /// Size of the data buffer (0 for the data-less base class).
    pub fn get_data_size(&self) -> i32 {
        self.ab.len() as i32
    }

    /// Marks node `id64` consumed and returns a reader over its body (Java positions the cache's own
    /// reader there). `None` if the node is unknown or already consumed.
    pub fn get_and_clear(&mut self, id64: i64) -> Option<ByteDataReader<'_>> {
        let size = self.get_size();
        if size == 0 {
            return None;
        }
        let id = self.shrink_id(id64);
        let mut offset = self.p2size;
        let mut n = 0i32;

        while offset > 0 {
            let nn = n + offset;
            if nn < size && self.faid[nn as usize] <= id {
                n = nn;
            }
            offset >>= 1;
        }
        let n = n as usize;
        if self.faid[n] != id || self.fapos[n] & DELETED != 0 {
            return None;
        }
        let start = self.start_pos(n);
        let end = self.fapos[n];
        self.fapos[n] |= DELETED; // mark deleted
        self.delbytes += end - start;
        self.delcount += 1;
        Some(ByteDataReader::new(&self.ab[start as usize..end as usize]))
    }

    fn start_pos(&self, n: usize) -> i32 {
        if n > 0 { self.fapos[n - 1] & 0x7fff_ffff } else { 0 }
    }

    /// Drops consumed nodes once more than `threshold` are consumed. Returns the bytes freed.
    pub fn collect(&mut self, threshold: i32) -> i32 {
        if self.delcount <= threshold {
            return 0;
        }

        self.virgin = false;

        let nsize = (self.get_size() - self.delcount) as usize;
        if nsize == 0 {
            // Java keeps the data array here, so getDataSize stays the same
            self.faid = Vec::new();
            self.fapos = Vec::new();
        } else {
            let mut nfaid = Vec::with_capacity(nsize);
            let mut nfapos = Vec::with_capacity(nsize);
            let mut nab = Vec::with_capacity(self.ab.len() - self.delbytes as usize);
            for (i, &pos) in self.fapos.iter().enumerate() {
                if pos & DELETED == 0 {
                    nab.extend_from_slice(&self.ab[self.start_pos(i) as usize..pos as usize]);
                    nfaid.push(self.faid[i]);
                    nfapos.push(nab.len() as i32);
                }
            }
            nab.resize(self.ab.len() - self.delbytes as usize, 0);
            self.faid = nfaid;
            self.fapos = nfapos;
            self.ab = nab;
        }
        let deleted = self.delbytes;
        self.init();
        deleted
    }

    pub fn un_ghost(&mut self) {
        self.ghost = false;
        self.delcount = 0;
        self.delbytes = 0;
        for pos in &mut self.fapos {
            *pos &= 0x7fff_ffff; // clear deleted flags
        }
    }

    /// The 64-bit global id of the node at cache position `i`.
    pub fn get_id_for_index(&self, i: usize) -> i64 {
        self.expand_id(self.faid[i])
    }

    fn cell(&self, what: &str) -> CellBase {
        self.v2.unwrap_or_else(|| panic!("{what} for empty cache"))
    }

    /// Expands a cache-internal 32-bit id into a 64-bit `(lon << 32 | lat)` id.
    pub fn expand_id(&self, id32: i32) -> i64 {
        let cell = self.cell("expandId");
        let d = expand_id32(id32);
        let lon32 = cell.lon_base.wrapping_add((d >> 32) as i32);
        let lat32 = cell.lat_base.wrapping_add(d as i32);
        (i64::from(lon32) << 32) | i64::from(lat32)
    }

    /// Shrinks a 64-bit `(lon << 32 | lat)` id into a cache-internal 32-bit id.
    pub fn shrink_id(&self, id64: i64) -> i32 {
        let cell = self.cell("shrinkId");
        let dlon = ((id64 >> 32) as i32).wrapping_sub(cell.lon_base);
        let dlat = (id64 as i32).wrapping_sub(cell.lat_base);
        let mut id32 = 0i32;
        let mut bm = 0x4000;
        while bm > 0 {
            id32 <<= 2;
            if dlon & bm != 0 {
                id32 |= 1;
            }
            if dlat & bm != 0 {
                id32 |= 2;
            }
            bm >>= 1;
        }
        id32
    }

    /// True if the position lies in this cache's cell.
    pub fn is_internal(&self, ilon: i32, ilat: i32) -> bool {
        let c = self.cell("isInternal");
        ilon >= c.lon_base && ilon < c.lon_base + c.cellsize && ilat >= c.lat_base && ilat < c.lat_base + c.cellsize
    }

    /// The `MicroCache2` decoding constructor: decodes a cell, dropping the ways `way_validator`
    /// rejects and feeding the usable ones to `waypoint_matcher`.
    pub fn decode_v2(
        bc: &mut StatCoderContext,
        data_buffers: &mut DataBuffers,
        lon_idx: i32,
        lat_idx: i32,
        divisor: i32,
        way_validator: &mut dyn TagValueValidator,
        mut waypoint_matcher: Option<&mut dyn WaypointMatcher>,
    ) -> MicroCache {
        let cellsize = 1_000_000 / divisor;
        let cell = CellBase { lon_base: lon_idx * cellsize, lat_base: lat_idx * cellsize, cellsize };
        let mut mc = MicroCache { v2: Some(cell), ..Self::empty_cache() };

        let way_tag_coder = TagValueCoder::new(bc, data_buffers, Some(&mut *way_validator));
        let node_tag_coder = TagValueCoder::new(bc, data_buffers, None);
        let node_idx_diff = NoisyDiffCoder::new(bc);
        let node_ele_diff = NoisyDiffCoder::new(bc);
        let ext_lon_diff = NoisyDiffCoder::new(bc);
        let ext_lat_diff = NoisyDiffCoder::new(bc);
        let trans_ele_diff = NoisyDiffCoder::new(bc);

        let DataBuffers { bbuf1, ibuf1, ibuf2: faid, ibuf3: fapos, alon, alat, .. } = data_buffers;
        let size = bc.decode_noisy_number(5);
        let usize_ = size as usize;
        faid.clear();
        faid.resize(usize_, 0);
        fapos.clear();
        fapos.resize(usize_, 0);

        bc.decode_sorted_array(faid, 0, size, 29, 0);

        alon.clear();
        alat.clear();
        for &id32 in faid.iter() {
            let id64 = mc.expand_id(id32);
            alon.push((id64 >> 32) as i32);
            alat.push(id64 as i32);
        }

        let _netdatasize = bc.decode_noisy_number(10);
        let mut w = ByteDataWriter::new(std::mem::take(bbuf1));

        let mut valid = vec![false; usize_];
        let mut finaldatasize = 0usize;
        let mut reverse_links = LinkedListContainer::new(usize_, std::mem::take(ibuf1));

        let mut selev = 0i32;
        for n in 0..usize_ {
            let ilon = alon[n];
            let ilat = alat[n];

            // future escapes (turn restrictions?)
            let mut tr_exceptions: i16 = 0;
            let mut feature_id = bc.decode_var_bits();
            if feature_id == 13 {
                fapos[n] = w.aboffset as i32;
                valid[n] = true; // mark dummy-node valid
                continue; // empty node escape (delta files only)
            }
            while feature_id != 0 {
                let bitsize = bc.decode_noisy_number(5);

                if feature_id == 2 {
                    // exceptions to turn-restriction
                    tr_exceptions = bc.decode_bounded(1023) as i16;
                } else if feature_id == 1 {
                    // turn-restriction
                    w.write_boolean(true);
                    w.write_short(i32::from(tr_exceptions)); // exceptions from previous feature
                    tr_exceptions = 0;

                    w.write_boolean(bc.decode_bit()); // isPositive
                    w.write_int(ilon.wrapping_add(bc.decode_noisy_diff(10))); // fromLon
                    w.write_int(ilat.wrapping_add(bc.decode_noisy_diff(10))); // fromLat
                    w.write_int(ilon.wrapping_add(bc.decode_noisy_diff(10))); // toLon
                    w.write_int(ilat.wrapping_add(bc.decode_noisy_diff(10))); // toLat
                } else {
                    for _ in 0..bitsize {
                        bc.decode_bit(); // unknown feature, just skip
                    }
                }
                feature_id = bc.decode_var_bits();
            }
            w.write_boolean(false);

            selev = selev.wrapping_add(node_ele_diff.decode_signed_value(bc));
            w.write_short(i32::from(selev as i16));
            let node_tags = node_tag_coder.decode_tag_value_set(bc);
            w.write_var_bytes(node_tags.map(|t| &*t.data));

            let links = bc.decode_noisy_number(1);
            for _ in 0..links {
                let node_idx = (n as i32).wrapping_add(node_idx_diff.decode_signed_value(bc)) as usize;

                let dlon_remaining;
                let dlat_remaining;

                let mut is_reverse = false;
                if node_idx != n {
                    // internal (forward-) link
                    dlon_remaining = alon[node_idx].wrapping_sub(ilon);
                    dlat_remaining = alat[node_idx].wrapping_sub(ilat);
                } else {
                    is_reverse = bc.decode_bit();
                    dlon_remaining = ext_lon_diff.decode_signed_value(bc);
                    dlat_remaining = ext_lat_diff.decode_signed_value(bc);
                }

                let way_tags = way_tag_coder.decode_tag_value_set(bc);

                // Java also keeps tagless links when there is no validator; NodesCache always has one.
                let mut sizeoffset = None;
                if let Some(tags) = way_tags {
                    let start_pointer = w.aboffset;
                    sizeoffset = Some(w.write_size_place_holder());

                    w.write_var_length_signed(dlon_remaining);
                    w.write_var_length_signed(dlat_remaining);

                    valid[n] = true; // mark source-node valid
                    if node_idx != n {
                        // valid internal (forward-) link
                        reverse_links.add_data_element(node_idx, n as i32); // register reverse link
                        finaldatasize += 1 + w.aboffset - start_pointer; // reserve place for reverse
                        valid[node_idx] = true; // mark target-node valid
                    }
                    w.write_mode_and_desc(is_reverse, Some(&tags.data[..]));
                }

                if !is_reverse {
                    // write geometry for forward links only
                    let start = w.aboffset;
                    let delta = (dlon_remaining, dlat_remaining);
                    decode_transfer_nodes(bc, &trans_ele_diff, way_tags.is_some().then_some(&mut w), delta);
                    let geometry = &w.data()[start..w.aboffset];
                    let matcher = waypoint_matcher.as_deref_mut();
                    match_transfer_nodes(geometry, way_tags, way_validator, matcher, (ilon, ilat), delta);
                }
                if let Some(sizeoffset) = sizeoffset {
                    w.inject_size(sizeoffset);
                }
            }
            fapos[n] = w.aboffset as i32;
        }

        // calculate final data size
        let mut finalsize = 0;
        let mut startpos = 0;
        for (&endpos, &is_valid) in fapos.iter().zip(&valid) {
            if is_valid {
                finaldatasize += (endpos - startpos) as usize;
                finalsize += 1;
            }
            startpos = endpos;
        }
        // append the reverse links at the end of each node
        let ab_old = w.into_data();
        let mut w = ByteDataWriter::new(Vec::with_capacity(finaldatasize));
        let mut faid_new = Vec::with_capacity(finalsize);
        let mut fapos_new = Vec::with_capacity(finalsize);

        let mut startpos = 0usize;
        for n in 0..usize_ {
            let endpos = fapos[n] as usize;
            if valid[n] {
                w.write(&ab_old[startpos..endpos]);

                let cnt = reverse_links.init_list(n);
                for _ in 0..cnt {
                    let node_idx = reverse_links.get_data_element() as usize;
                    let sizeoffset = w.write_size_place_holder();
                    w.write_var_length_signed(alon[node_idx].wrapping_sub(alon[n]));
                    w.write_var_length_signed(alat[node_idx].wrapping_sub(alat[n]));
                    w.write_mode_and_desc(true, None);
                    w.inject_size(sizeoffset);
                }
                faid_new.push(faid[n]);
                fapos_new.push(w.aboffset as i32);
            }
            startpos = endpos;
        }
        mc.ab = w.into_data();
        mc.ab.resize(finaldatasize, 0); // Java allocates exactly finaldatasize
        mc.faid = faid_new;
        mc.fapos = fapos_new;
        mc.init();

        *bbuf1 = ab_old;
        *ibuf1 = reverse_links.into_buffer();
        mc
    }
}

//! Port of `ByteDataReader` and `ByteDataWriter`. Java reads and writes a caller's `byte[]` through one
//! class hierarchy; here the reader borrows its bytes and the writer owns a buffer that grows on demand
//! (Java's arrays are sized up front and would throw on overflow instead).

/// Reading side of `ByteDataReader` over a borrowed slice.
pub struct ByteDataReader<'a> {
    ab: &'a [u8],
    aboffset: usize,
}

impl<'a> ByteDataReader<'a> {
    pub fn new(ab: &'a [u8]) -> Self {
        Self::with_offset(ab, 0)
    }

    pub fn with_offset(ab: &'a [u8], offset: usize) -> Self {
        Self { ab, aboffset: offset }
    }

    /// The next `len` bytes.
    pub fn read_bytes(&mut self, len: usize) -> &'a [u8] {
        let bytes = &self.ab[self.aboffset..self.aboffset + len];
        self.aboffset += len;
        bytes
    }

    pub fn read_int(&mut self) -> i32 {
        i32::from_be_bytes(self.read_bytes(4).try_into().unwrap())
    }

    pub fn read_long(&mut self) -> i64 {
        i64::from_be_bytes(self.read_bytes(8).try_into().unwrap())
    }

    pub fn read_boolean(&mut self) -> bool {
        self.read_byte() != 0
    }

    pub fn read_byte(&mut self) -> i8 {
        self.read_bytes(1)[0] as i8
    }

    pub fn read_short(&mut self) -> i16 {
        i16::from_be_bytes(self.read_bytes(2).try_into().unwrap())
    }

    pub fn read_var_length_signed(&mut self) -> i32 {
        let v = self.read_var_length_unsigned();
        if v & 1 == 0 { v >> 1 } else { -(v >> 1) }
    }

    pub fn read_var_length_unsigned(&mut self) -> i32 {
        let mut b = self.read_byte();
        let mut v = i32::from(b) & 0x7f;
        if b >= 0 {
            return v;
        }
        b = self.read_byte();
        v |= (i32::from(b) & 0x7f) << 7;
        if b >= 0 {
            return v;
        }
        b = self.read_byte();
        v |= (i32::from(b) & 0x7f) << 14;
        if b >= 0 {
            return v;
        }
        b = self.read_byte();
        v |= (i32::from(b) & 0x7f) << 21;
        if b >= 0 {
            return v;
        }
        b = self.read_byte();
        v | (i32::from(b) & 0xf) << 28
    }

    /// Reads a size and returns the offset just after a section of that size.
    pub fn get_end_pointer(&mut self) -> usize {
        let size = self.read_var_length_unsigned();
        self.aboffset + size as usize
    }

    /// The bytes up to `end_pointer`, `None` for none.
    pub fn read_data_until(&mut self, end_pointer: usize) -> Option<&'a [u8]> {
        let size = end_pointer - self.aboffset;
        (size > 0).then(|| self.read_bytes(size))
    }

    pub fn has_more_data(&self) -> bool {
        self.aboffset < self.ab.len()
    }
}

/// Writing side of `ByteDataWriter`, as used by `MicroCache2` and the direct weaver.
#[derive(Default)]
pub struct ByteDataWriter {
    ab: Vec<u8>,
    pub aboffset: usize,
}

impl ByteDataWriter {
    /// A writer at offset 0 that reuses `ab`'s allocation: writing overwrites it and grows it past its
    /// end.
    pub fn new(ab: Vec<u8>) -> Self {
        Self { ab, aboffset: 0 }
    }

    pub fn data(&self) -> &[u8] {
        &self.ab
    }

    pub fn into_data(self) -> Vec<u8> {
        self.ab
    }

    fn put(&mut self, b: u8) {
        // aboffset never passes the end
        if self.aboffset == self.ab.len() {
            self.ab.push(b);
        } else {
            self.ab[self.aboffset] = b;
        }
        self.aboffset += 1;
    }

    pub fn write(&mut self, sa: &[u8]) {
        let overlap = self.ab.len().saturating_sub(self.aboffset).min(sa.len());
        self.ab[self.aboffset..self.aboffset + overlap].copy_from_slice(&sa[..overlap]);
        self.ab.extend_from_slice(&sa[overlap..]);
        self.aboffset += sa.len();
    }

    pub fn write_int(&mut self, v: i32) {
        self.write(&v.to_be_bytes());
    }

    pub fn write_boolean(&mut self, v: bool) {
        self.put(u8::from(v));
    }

    pub fn write_short(&mut self, v: i32) {
        self.write(&[(v >> 8) as u8, v as u8]);
    }

    pub fn write_var_bytes(&mut self, sa: Option<&[u8]>) {
        match sa {
            None => self.write_var_length_unsigned(0),
            Some(sa) => {
                self.write_var_length_unsigned(sa.len() as i32);
                self.write(sa);
            }
        }
    }

    pub fn write_mode_and_desc(&mut self, is_reverse: bool, sa: Option<&[u8]>) {
        let len = sa.map_or(0, <[u8]>::len) as i32;
        self.write_var_length_unsigned((len << 1) | i32::from(is_reverse));
        if let Some(sa) = sa {
            self.write(sa);
        }
    }

    /// Reserves one byte for a size prefix written later by `inject_size`.
    pub fn write_size_place_holder(&mut self) -> usize {
        self.put(0);
        self.aboffset - 1
    }

    pub fn inject_size(&mut self, sizeoffset: usize) {
        let datasize = self.aboffset - sizeoffset - 1;
        let mut size = 0;
        let mut v = datasize;
        loop {
            v >>= 7;
            size += 1;
            if v == 0 {
                break;
            }
        }
        if size > 1 {
            // doesn't fit -> shift the data after the placeholder
            let end = sizeoffset + size + datasize;
            if self.ab.len() < end {
                self.ab.resize(end, 0);
            }
            self.ab.copy_within(sizeoffset + 1..sizeoffset + 1 + datasize, sizeoffset + size);
        }
        self.aboffset = sizeoffset;
        self.write_var_length_unsigned(datasize as i32);
        self.aboffset = sizeoffset + size + datasize;
    }

    pub fn write_var_length_signed(&mut self, v: i32) {
        self.write_var_length_unsigned(if v < 0 { v.wrapping_neg().wrapping_shl(1) | 1 } else { v.wrapping_shl(1) });
    }

    pub fn write_var_length_unsigned(&mut self, v: i32) {
        let mut v = v as u32;
        for _ in 0..4 {
            let i7 = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                self.put(i7);
                return;
            }
            self.put(i7 | 0x80);
        }
        self.put(v as u8);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn var_length_round_trip() {
        // Java's format round-trips magnitudes below 2^30 only.
        let values = [0, 1, 63, 64, 127, 128, 16_383, 16_384, -1, -64, -65, (1 << 30) - 1, -(1 << 30) + 1, 1 << 28];
        let mut w = ByteDataWriter::default();
        for &v in &values {
            w.write_var_length_signed(v);
        }
        w.write_var_length_unsigned(-1);
        let ab = w.into_data();
        let mut r = ByteDataReader::new(&ab);
        for &v in &values {
            assert_eq!(r.read_var_length_signed(), v);
        }
        assert_eq!(r.read_var_length_unsigned(), -1);
        assert!(!r.has_more_data());
    }

    #[test]
    fn inject_size_shifts_long_sections() {
        let mut w = ByteDataWriter::new(vec![9; 3]); // overwrites the stale bytes, then grows
        let offset = w.write_size_place_holder();
        w.write(&[7; 200]);
        w.inject_size(offset);
        w.write_int(0x0102_0304);
        let ab = w.into_data();
        assert_eq!(ab.len(), 2 + 200 + 4);
        let mut r = ByteDataReader::new(&ab);
        let end = r.get_end_pointer();
        assert_eq!(end, 202);
        assert_eq!(r.read_data_until(end).unwrap(), &[7; 200][..]);
        assert_eq!(r.read_data_until(end), None);
        assert_eq!(r.read_int(), 0x0102_0304);
    }

    #[test]
    fn fixed_width_values_are_big_endian() {
        let ab = [0x80, 0, 0, 1, 0xff, 0xfe, 1, 0, 0, 0, 0, 0, 0, 0, 2];
        let mut r = ByteDataReader::new(&ab);
        assert_eq!(r.read_int(), i32::MIN + 1);
        assert_eq!(r.read_short(), -2);
        assert!(r.read_boolean());
        assert_eq!(r.read_long(), 2);
    }
}

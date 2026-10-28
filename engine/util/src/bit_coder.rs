//! Port of `BitCoderContext`. Java keeps reading and writing in one class over a caller's array; here the
//! reader borrows its bytes and the writer owns a growing buffer. Shifts by a variable amount use
//! `wrapping_shr`/`wrapping_shl`, which mask the distance to five bits exactly like Java's `int` shifts.

use std::sync::LazyLock;

struct Tables {
    vl_values: [i32; 4096],
    vl_length: [i32; 4096],
    vc_values: [u32; 4096],
    vc_length: [i32; 4096],
    reverse_byte: [u32; 256],
}

static TABLES: LazyLock<Tables> = LazyLock::new(|| {
    let mut tables = Tables {
        vl_values: [0; 4096],
        vl_length: [0; 4096],
        vc_values: [0; 4096],
        vc_length: [0; 4096],
        reverse_byte: [0; 256],
    };
    let zeros = [0u8; 4];
    for i in 0..4096 {
        let mut bc = BitCoderContext::new(&zeros);
        bc.bits = 14;
        bc.b = 0x1000 + i as u32;
        let b0 = bc.reading_bit_position();
        tables.vl_values[i] = bc.decode_var_bits2();
        tables.vl_length[i] = bc.reading_bit_position() - b0;
    }
    for i in 0..4096 {
        let mut bw = BitWriter::new();
        let b0 = bw.writing_bit_position();
        bw.encode_var_bits2(i as i32);
        tables.vc_values[i] = bw.b;
        tables.vc_length[i] = bw.writing_bit_position() - b0;
    }
    for (b, reversed) in tables.reverse_byte.iter_mut().enumerate() {
        *reversed = (b as u8).reverse_bits().into();
    }
    tables
});

/// Reading side of `BitCoderContext`.
pub struct BitCoderContext<'a> {
    ab: &'a [u8],
    idx_max: i32,
    idx: i32,
    /// Bits left in the buffer.
    bits: i32,
    /// Buffer word.
    b: u32,
}

impl<'a> BitCoderContext<'a> {
    pub fn new(ab: &'a [u8]) -> Self {
        Self { ab, idx_max: ab.len() as i32 - 1, idx: -1, bits: 0, b: 0 }
    }

    pub fn reset_to(&mut self, ab: &'a [u8]) {
        self.ab = ab;
        self.idx_max = ab.len() as i32 - 1;
        self.reset();
    }

    pub fn reset(&mut self) {
        self.idx = -1;
        self.bits = 0;
        self.b = 0;
    }

    fn next_byte(&mut self) -> u32 {
        self.idx += 1;
        self.ab[self.idx as usize].into()
    }

    /// Decodes `encode_var_bits2`'s format bit by bit.
    pub fn decode_var_bits2(&mut self) -> i32 {
        let mut range = 0i32;
        while !self.decode_bit() {
            range = range.wrapping_mul(2).wrapping_add(1);
        }
        range.wrapping_add(self.decode_bounded(range))
    }

    pub fn decode_var_bits(&mut self) -> i32 {
        self.fill_buffer();
        let tables = &*TABLES;
        let b12 = (self.b & 0xfff) as usize;
        let len = tables.vl_length[b12];
        if len <= 12 {
            self.b = self.b.wrapping_shr(len as u32);
            self.bits -= len;
            return tables.vl_values[b12]; // full value lookup
        }
        if len <= 23 {
            // only length lookup
            let len2 = len >> 1;
            self.b = self.b.wrapping_shr((len2 + 1) as u32);
            let mut mask = u32::MAX.wrapping_shr((32 - len2) as u32);
            mask = mask.wrapping_add(self.b & mask);
            self.b = self.b.wrapping_shr(len2 as u32);
            self.bits -= len;
            return mask as i32;
        }
        if self.b & 0xff_ffff != 0 {
            // here we just know len in [25..47] (fill_buffer guarantees only 24 bits)
            self.b >>= 12;
            let len3 = 1 + (tables.vl_length[(self.b & 0xfff) as usize] >> 1);
            self.b = self.b.wrapping_shr(len3 as u32);
            let len2 = 11 + len3;
            self.bits -= len2 + 1;
            self.fill_buffer();
            let mut mask = u32::MAX.wrapping_shr((32 - len2) as u32);
            mask = mask.wrapping_add(self.b & mask);
            self.b = self.b.wrapping_shr(len2 as u32);
            self.bits -= len2;
            return mask as i32;
        }
        self.decode_var_bits2() // no chance, use the slow one
    }

    pub fn decode_bit(&mut self) -> bool {
        if self.bits == 0 {
            self.bits = 8;
            self.b = self.next_byte();
        }
        let value = self.b & 1 != 0;
        self.b >>= 1;
        self.bits -= 1;
        value
    }

    /// Decodes an integer in the range `0..=max` written by `encode_bounded`.
    pub fn decode_bounded(&mut self, max: i32) -> i32 {
        let mut value = 0i32;
        let mut im = 1i32; // integer mask
        while (value | im) <= max {
            if self.bits == 0 {
                self.bits = 8;
                self.b = self.next_byte();
            }
            if self.b & 1 != 0 {
                value |= im;
            }
            self.b >>= 1;
            self.bits -= 1;
            im = im.wrapping_shl(1);
        }
        value
    }

    pub fn decode_bits(&mut self, count: i32) -> i32 {
        self.fill_buffer();
        let mask = u32::MAX.wrapping_shr((32 - count) as u32);
        let value = self.b & mask;
        self.b = self.b.wrapping_shr(count as u32);
        self.bits -= count;
        value as i32
    }

    pub fn decode_bits_reverse(&mut self, mut count: i32) -> i32 {
        self.fill_buffer();
        let reverse_byte = &TABLES.reverse_byte;
        let mut value = 0u32;
        while count > 8 {
            value = (value << 8) | reverse_byte[(self.b & 0xff) as usize];
            self.b >>= 8;
            count -= 8;
            self.bits -= 8;
            self.fill_buffer();
        }
        value = value.wrapping_shl(count as u32) | (reverse_byte[(self.b & 0xff) as usize] >> (8 - count));
        self.bits -= count;
        self.b = self.b.wrapping_shr(count as u32);
        value as i32
    }

    fn fill_buffer(&mut self) {
        while self.bits < 24 {
            let previous = self.idx;
            self.idx += 1;
            if previous < self.idx_max {
                self.b |= u32::from(self.ab[self.idx as usize]) << self.bits;
            }
            self.bits += 8;
        }
    }

    pub fn reading_bit_position(&self) -> i32 {
        (self.idx << 3) + 8 - self.bits
    }

    pub fn set_reading_bit_position(&mut self, pos: i32) {
        self.idx = ((pos as u32) >> 3) as i32;
        self.bits = (self.idx << 3) + 8 - pos;
        self.b = u32::from(self.ab[self.idx as usize]).wrapping_shr((8 - self.bits) as u32);
    }
}

/// Writing side of `BitCoderContext`, used to build its tables and to test the reader.
#[derive(Default)]
pub struct BitWriter {
    ab: Vec<u8>,
    bits: i32,
    b: u32,
}

impl BitWriter {
    pub fn new() -> Self {
        Self::default()
    }

    /// An empty writer that reuses `ab`'s allocation, like Java's `reset(byte[])` on a scratch buffer.
    pub fn with_buffer(mut ab: Vec<u8>) -> Self {
        ab.clear();
        Self { ab, bits: 0, b: 0 }
    }

    /// Variable bit length ("poor man's huffman tree"): `1 -> 0`, `01 -> 1` plus a 1-bit word (1..2),
    /// `001 -> 3` plus a 2-bit word (3..6), `0001 -> 7` plus a 3-bit word (7..14), and so on.
    pub fn encode_var_bits2(&mut self, mut value: i32) {
        let mut range = 0i32;
        while value > range {
            self.encode_bit(false);
            value -= range + 1;
            range = 2 * range + 1;
        }
        self.encode_bit(true);
        self.encode_bounded(range, value);
    }

    pub fn encode_var_bits(&mut self, value: i32) {
        if value & 0xfff == value {
            self.flush_buffer();
            let tables = &*TABLES;
            self.b |= tables.vc_values[value as usize] << self.bits;
            self.bits += tables.vc_length[value as usize];
        } else {
            self.encode_var_bits2(value); // slow fallback for large values
        }
    }

    pub fn encode_bit(&mut self, value: bool) {
        if self.bits > 31 {
            self.ab.push(self.b as u8);
            self.b >>= 8;
            self.bits -= 8;
        }
        if value {
            self.b |= 1u32.wrapping_shl(self.bits as u32);
        }
        self.bits += 1;
    }

    /// Encodes an integer in the range `0..=max`; shorter codes go to the central value range.
    pub fn encode_bounded(&mut self, mut max: i32, value: i32) {
        let mut im = 1i32; // integer mask
        while im <= max {
            if value & im != 0 {
                self.encode_bit(true);
                max -= im;
            } else {
                self.encode_bit(false);
            }
            im <<= 1;
        }
    }

    fn flush_buffer(&mut self) {
        while self.bits > 7 {
            self.ab.push(self.b as u8);
            self.b >>= 8;
            self.bits -= 8;
        }
    }

    pub fn writing_bit_position(&self) -> i32 {
        ((self.ab.len() as i32 - 1) << 3) + 8 + self.bits
    }

    /// Flushes and returns the encoded bytes.
    pub fn finish(mut self) -> Vec<u8> {
        self.flush_buffer();
        if self.bits > 0 {
            self.ab.push(self.b as u8);
        }
        self.ab
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn var_bits_round_trip() {
        // The same sequence as BitCoderContext.main in Java.
        let mut bw = BitWriter::new();
        for i in 0..31 {
            bw.encode_var_bits((1 << i) + 3);
        }
        for i in (0..100_000).step_by(13) {
            bw.encode_var_bits(i);
        }
        let ab = bw.finish();
        let mut bc = BitCoderContext::new(&ab);
        for i in 0..31 {
            assert_eq!(bc.decode_var_bits(), (1 << i) + 3);
        }
        for i in (0..100_000).step_by(13) {
            assert_eq!(bc.decode_var_bits(), i);
        }
    }

    #[test]
    fn tables_match_java() {
        let tables = &*TABLES;
        // 0x1000 + 0: twelve zero bits, the stop bit, then a 12-bit word of zeros.
        assert_eq!((tables.vl_values[0], tables.vl_length[0]), (4095, 25));
        assert_eq!((tables.vl_values[1], tables.vl_length[1]), (0, 1));
        assert_eq!((tables.vc_values[0], tables.vc_length[0]), (1, 1));
        assert_eq!(tables.reverse_byte[1], 0x80);
    }

    #[test]
    fn bounded_bits_and_positions() {
        let mut bw = BitWriter::new();
        bw.encode_bounded(1000, 777);
        bw.encode_bit(true);
        bw.encode_var_bits2(5000);
        let ab = bw.finish();
        let mut bc = BitCoderContext::new(&ab);
        assert_eq!(bc.decode_bounded(1000), 777);
        let position = bc.reading_bit_position();
        assert!(bc.decode_bit());
        assert_eq!(bc.decode_var_bits(), 5000);
        bc.set_reading_bit_position(position);
        assert!(bc.decode_bit());
        assert_eq!(bc.decode_var_bits2(), 5000);
    }
}

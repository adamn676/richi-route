//! A fast hash for short keys (descriptions, positions), far cheaper than std's SipHash on hot paths.
//! The keys come from map data and rule files, not from requests.

use std::hash::{BuildHasherDefault, Hasher};

#[derive(Default)]
pub struct FxHasher(u64);

pub type FxBuildHasher = BuildHasherDefault<FxHasher>;

impl Hasher for FxHasher {
    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8) {
            let mut word = [0u8; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            self.write_u64(u64::from_le_bytes(word));
        }
    }

    fn write_u64(&mut self, v: u64) {
        self.0 = (self.0.rotate_left(5) ^ v).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }

    fn write_u32(&mut self, v: u32) {
        self.write_u64(u64::from(v));
    }

    fn write_i32(&mut self, v: i32) {
        self.write_u32(v as u32);
    }

    fn write_usize(&mut self, v: usize) {
        self.write_u64(v as u64);
    }

    fn finish(&self) -> u64 {
        // the table picks buckets by the low bits, which the multiplication fills from low bits only
        self.0.rotate_left(26)
    }
}

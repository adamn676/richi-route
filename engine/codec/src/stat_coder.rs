use brouter_util::BitCoderContext;
use std::ops::{Deref, DerefMut};

/// `noisy_bits[i]`: the number of halvings until `i <= 2`.
const NOISY_BITS: [i32; 1024] = {
    let mut table = [0; 1024];
    let mut i = 0;
    while i < 1024 {
        let mut p = i;
        while p > 2 {
            table[i] += 1;
            p >>= 1;
        }
        i += 1;
    }
    table
};

/// Decoding side of `StatCoderContext`, which extends `BitCoderContext` (hence the `Deref`).
pub struct StatCoderContext<'a> {
    bc: BitCoderContext<'a>,
}

impl<'a> Deref for StatCoderContext<'a> {
    type Target = BitCoderContext<'a>;
    fn deref(&self) -> &Self::Target {
        &self.bc
    }
}

impl DerefMut for StatCoderContext<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.bc
    }
}

impl<'a> StatCoderContext<'a> {
    pub fn new(ab: &'a [u8]) -> Self {
        Self { bc: BitCoderContext::new(ab) }
    }

    /// Decodes an unsigned integer whose `noisybits` least significant bits are stored verbatim.
    pub fn decode_noisy_number(&mut self, noisybits: i32) -> i32 {
        let value = self.decode_bits(noisybits);
        value | self.decode_var_bits().wrapping_shl(noisybits as u32)
    }

    /// Decodes a signed integer whose `noisybits` least significant bits are stored verbatim.
    pub fn decode_noisy_diff(&mut self, noisybits: i32) -> i32 {
        let mut value = 0;
        if noisybits > 0 {
            value = self.decode_bits(noisybits).wrapping_sub(1 << (noisybits - 1));
        }
        let mut val2 = self.decode_var_bits().wrapping_shl(noisybits as u32);
        if val2 != 0 && self.decode_bit() {
            val2 = val2.wrapping_neg();
        }
        value.wrapping_add(val2)
    }

    /// Decodes a signed integer with typical range and median taken from `predictor`.
    pub fn decode_predicted_value(&mut self, predictor: i32) -> i32 {
        let mut p = if predictor < 0 { predictor.wrapping_neg() } else { predictor };
        let mut noisybits = 0;
        while p > 1023 {
            noisybits += 1;
            p >>= 1;
        }
        predictor.wrapping_add(self.decode_noisy_diff(noisybits + NOISY_BITS[p as usize]))
    }

    /// Decodes `subsize` sorted values into `values[offset..]`, written by recursively encoding, from
    /// the most significant bit down, how many values have the current bit clear.
    pub fn decode_sorted_array(
        &mut self,
        values: &mut [i32],
        mut offset: usize,
        mut subsize: i32,
        nextbitpos: i32,
        mut value: i32,
    ) {
        if subsize == 1 {
            // last-choice shortcut
            if nextbitpos >= 0 {
                value |= self.decode_bits_reverse(nextbitpos + 1);
            }
            values[offset] = value;
            return;
        }
        if nextbitpos < 0 {
            while subsize > 0 {
                subsize -= 1;
                values[offset] = value;
                offset += 1;
            }
            return;
        }

        let size1 = self.decode_bounded(subsize);
        let size2 = subsize - size1;

        if size1 > 0 {
            self.decode_sorted_array(values, offset, size1, nextbitpos - 1, value);
        }
        if size2 > 0 {
            self.decode_sorted_array(values, offset + size1 as usize, size2, nextbitpos - 1, value | (1 << nextbitpos));
        }
    }
}

/// Decoding side of `NoisyDiffCoder`: signed values with a per-stream count of noisy bits.
pub struct NoisyDiffCoder {
    noisybits: i32,
}

impl NoisyDiffCoder {
    /// Reads the noisy-bit count from the stream.
    pub fn new(bc: &mut StatCoderContext) -> Self {
        Self { noisybits: bc.decode_var_bits() }
    }

    pub fn decode_signed_value(&self, bc: &mut StatCoderContext) -> i32 {
        bc.decode_noisy_diff(self.noisybits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brouter_util::BitWriter;

    // Encoders as in Java's StatCoderContext, to test the decoders.
    fn encode_noisy_number(bw: &mut BitWriter, mut value: i32, noisybits: i32) {
        if noisybits > 0 {
            let mask = (u32::MAX >> (32 - noisybits)) as i32;
            bw.encode_bounded(mask, value & mask);
            value >>= noisybits;
        }
        bw.encode_var_bits(value);
    }

    fn encode_noisy_diff(bw: &mut BitWriter, mut value: i32, noisybits: i32) {
        if noisybits > 0 {
            value += 1 << (noisybits - 1);
            let mask = (u32::MAX >> (32 - noisybits)) as i32;
            bw.encode_bounded(mask, value & mask);
            value >>= noisybits;
        }
        bw.encode_var_bits(value.abs());
        if value != 0 {
            bw.encode_bit(value < 0);
        }
    }

    fn encode_sorted_array(
        bw: &mut BitWriter,
        values: &[i32],
        offset: usize,
        subsize: usize,
        mut nextbit: i32,
        mut mask: i32,
    ) {
        if subsize == 1 {
            while nextbit != 0 {
                bw.encode_bit(values[offset] & nextbit != 0);
                nextbit >>= 1;
            }
        }
        if nextbit == 0 {
            return;
        }
        let data = mask & values[offset];
        mask |= nextbit;
        let mut i = offset;
        let end = subsize + offset;
        while i < end && values[i] & mask == data {
            i += 1;
        }
        let size1 = i - offset;
        let size2 = subsize - size1;
        bw.encode_bounded(subsize as i32, size1 as i32);
        if size1 > 0 {
            encode_sorted_array(bw, values, offset, size1, nextbit >> 1, mask);
        }
        if size2 > 0 {
            encode_sorted_array(bw, values, i, size2, nextbit >> 1, mask);
        }
    }

    #[test]
    fn round_trips() {
        let sorted = [3, 17, 18, 1000, 65_536, 0x1fff_ffff];
        let mut bw = BitWriter::new();
        encode_noisy_number(&mut bw, 1234, 5);
        encode_noisy_diff(&mut bw, -777, 3);
        encode_noisy_diff(&mut bw, 5, 0);
        encode_sorted_array(&mut bw, &sorted, 0, sorted.len(), 0x2000_0000, 0);
        let ab = bw.finish();
        let mut bc = StatCoderContext::new(&ab);
        assert_eq!(bc.decode_noisy_number(5), 1234);
        assert_eq!(bc.decode_noisy_diff(3), -777);
        assert_eq!(bc.decode_noisy_diff(0), 5);
        let mut values = [0; 6];
        bc.decode_sorted_array(&mut values, 0, 6, 29, 0);
        assert_eq!(values, sorted);
    }

    #[test]
    fn noisy_bits_table() {
        assert_eq!(&NOISY_BITS[..9], &[0, 0, 0, 1, 1, 1, 2, 2, 2]);
        assert_eq!(NOISY_BITS[1023], 9);
    }
}

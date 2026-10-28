/// Port of `Crc32.crc`; like Java it returns the register without the final inversion. Computed eight
/// bytes at a time ("slicing by 8"), which gives the same register as Java's byte-wise loop.
pub fn crc(ab: &[u8], offset: usize, len: usize) -> i32 {
    let data = &ab[offset..offset + len];
    let mut crc = 0xFFFF_FFFFu32;
    let (chunks, rest) = data.as_chunks::<8>();
    for chunk in chunks {
        let lo = crc ^ u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        crc = TABLES[7][(lo & 0xff) as usize]
            ^ TABLES[6][((lo >> 8) & 0xff) as usize]
            ^ TABLES[5][((lo >> 16) & 0xff) as usize]
            ^ TABLES[4][(lo >> 24) as usize]
            ^ TABLES[3][chunk[4] as usize]
            ^ TABLES[2][chunk[5] as usize]
            ^ TABLES[1][chunk[6] as usize]
            ^ TABLES[0][chunk[7] as usize];
    }
    for &byte in rest {
        crc = (crc >> 8) ^ TABLES[0][((crc ^ u32::from(byte)) & 0xff) as usize];
    }
    crc as i32
}

/// `TABLES[0]` is Java's table; `TABLES[k][b]` is the register after `b` followed by `k` zero bytes.
const TABLES: [[u32; 256]; 8] = {
    let mut tables = [[0u32; 256]; 8];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        tables[0][n] = c;
        n += 1;
    }
    let mut t = 1;
    while t < 8 {
        let mut n = 0;
        while n < 256 {
            let prev = tables[t - 1][n];
            tables[t][n] = (prev >> 8) ^ tables[0][(prev & 0xff) as usize];
            n += 1;
        }
        t += 1;
    }
    tables
};

#[cfg(test)]
mod tests {
    use super::*;

    fn bytewise(ab: &[u8]) -> i32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &byte in ab {
            crc = (crc >> 8) ^ TABLES[0][((crc ^ u32::from(byte)) & 0xff) as usize];
        }
        crc as i32
    }

    #[test]
    fn matches_java_table_and_register() {
        // Values from btools.util.Crc32's literal table.
        assert_eq!(TABLES[0][1], 0x7707_3096);
        assert_eq!(TABLES[0][255], 0x2d02_ef8d);
        // Java's crc() of "123456789" without the final inversion: !0xcbf43926.
        assert_eq!(crc(b"123456789", 0, 9), !0xcbf4_3926u32 as i32);
    }

    #[test]
    fn slicing_matches_bytewise() {
        let data: Vec<u8> = (0..1000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
        for (offset, len) in [(0, 0), (0, 7), (3, 8), (1, 9), (5, 200), (0, 1000), (17, 983)] {
            assert_eq!(crc(&data, offset, len), bytewise(&data[offset..offset + len]), "{offset} {len}");
        }
    }
}

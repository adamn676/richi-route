/// Port of `Crc32.crc`; like Java it returns the register without the final inversion.
pub fn crc(ab: &[u8], offset: usize, len: usize) -> i32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in &ab[offset..offset + len] {
        crc = (crc >> 8) ^ TABLE[((crc ^ u32::from(byte)) & 0xff) as usize];
    }
    crc as i32
}

const TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_java_table_and_register() {
        // Values from btools.util.Crc32's literal table.
        assert_eq!(TABLE[1], 0x7707_3096);
        assert_eq!(TABLE[255], 0x2d02_ef8d);
        // Java's crc() of "123456789" without the final inversion: !0xcbf43926.
        assert_eq!(crc(b"123456789", 0, 9), !0xcbf4_3926u32 as i32);
    }
}

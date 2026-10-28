//! Java `Math`/`StrictMath` routines whose results Rust's `std` does not reproduce bit for bit.
//!
//! - `Math.round` rounds half up exactly, also where `floor(x + 0.5)` would round in floating point.
//! - `Math.atan2` delegates to `StrictMath.atan2`, the fdlibm port in `java.lang.FdLibm`; the platform
//!   `atan2` differs in the last bit for about one input in six.
//! - `Double.compare` orders `-0.0` before `0.0` and all NaNs after everything.

use std::cmp::Ordering;

/// `Math.round(double)`: `floor(a + 1/2)` computed exactly, saturating to `i64`, NaN to 0.
pub fn round(a: f64) -> i64 {
    let long_bits = a.to_bits() as i64;
    let biased_exp = (long_bits & 0x7ff0_0000_0000_0000) >> 52;
    let shift = (52 - 1 + 1023) - biased_exp;
    if shift & -64 == 0 {
        // a is finite with pow(2,-64) <= ulp(a) < 1
        let mut r = (long_bits & 0x000f_ffff_ffff_ffff) | 0x0010_0000_0000_0000;
        if long_bits < 0 {
            r = -r;
        }
        ((r >> shift) + 1) >> 1
    } else {
        a as i64
    }
}

/// `Math.round(float)`: `floor(a + 1/2)` computed exactly, saturating to `i32`, NaN to 0.
pub fn round_f32(a: f32) -> i32 {
    let int_bits = a.to_bits() as i32;
    let biased_exp = (int_bits & 0x7f80_0000) >> 23;
    let shift = (23 - 1 + 127) - biased_exp;
    if shift & -32 == 0 {
        let mut r = (int_bits & 0x007f_ffff) | 0x0080_0000;
        if int_bits < 0 {
            r = -r;
        }
        ((r >> shift) + 1) >> 1
    } else {
        a as i32
    }
}

/// `Math.toDegrees` (JDK 9+ multiplies by a constant).
pub fn to_degrees(angrad: f64) -> f64 {
    angrad * 57.295_779_513_082_32
}

/// `Double.compare`.
pub fn double_compare(d1: f64, d2: f64) -> Ordering {
    if d1 < d2 {
        return Ordering::Less;
    }
    if d1 > d2 {
        return Ordering::Greater;
    }
    // doubleToLongBits: all NaNs collapse to the canonical NaN
    let canonical = |d: f64| if d.is_nan() { 0x7ff8_0000_0000_0000i64 } else { d.to_bits() as i64 };
    canonical(d1).cmp(&canonical(d2))
}

fn hi(x: f64) -> i32 {
    (x.to_bits() >> 32) as i32
}

fn lo(x: f64) -> i32 {
    x.to_bits() as i32
}

const EXP_SIGNIF_BITS: i32 = 0x7fff_ffff;
const EXP_BITS: i32 = 0x7ff0_0000;

const ATANHI: [f64; 4] = [
    f64::from_bits(0x3fdd_ac67_0561_bb4f), // atan(0.5)hi
    f64::from_bits(0x3fe9_21fb_5444_2d18), // atan(1.0)hi
    f64::from_bits(0x3fef_730b_d281_f69b), // atan(1.5)hi
    f64::from_bits(0x3ff9_21fb_5444_2d18), // atan(inf)hi
];

const ATANLO: [f64; 4] = [
    f64::from_bits(0x3c7a_2b7f_222f_65e2), // atan(0.5)lo
    f64::from_bits(0x3c81_a626_3314_5c07), // atan(1.0)lo
    f64::from_bits(0x3c70_0788_7af0_cbbd), // atan(1.5)lo
    f64::from_bits(0x3c91_a626_3314_5c07), // atan(inf)lo
];

const AT: [f64; 11] = [
    f64::from_bits(0x3fd5_5555_5555_550d),
    f64::from_bits(0xbfc9_9999_9998_ebc4),
    f64::from_bits(0x3fc2_4924_9200_83ff),
    f64::from_bits(0xbfbc_71c6_fe23_1671),
    f64::from_bits(0x3fb7_45cd_c54c_206e),
    f64::from_bits(0xbfb3_b0f2_af74_9a6d),
    f64::from_bits(0x3fb1_0d66_a0d0_3d51),
    f64::from_bits(0xbfad_de2d_52de_fd9a),
    f64::from_bits(0x3fa9_7b4b_2476_0deb),
    f64::from_bits(0xbfa2_b444_2c6a_6c2f),
    f64::from_bits(0x3f90_ad3a_e322_da11),
];

const HUGE: f64 = 1.0e300;

/// `StrictMath.atan` (`FdLibm.Atan`).
pub fn atan(mut x: f64) -> f64 {
    let hx = hi(x);
    let ix = hx & EXP_SIGNIF_BITS;
    let id: i32;
    if ix >= 0x4410_0000 {
        // |x| >= 2^66
        if ix > EXP_BITS || (ix == EXP_BITS && lo(x) != 0) {
            return x + x; // NaN
        }
        return if hx > 0 { ATANHI[3] + ATANLO[3] } else { -ATANHI[3] - ATANLO[3] };
    }
    if ix < 0x3fdc_0000 {
        // |x| < 0.4375
        if ix < 0x3e20_0000 && HUGE + x > 1.0 {
            return x; // |x| < 2^-29
        }
        id = -1;
    } else {
        x = x.abs();
        if ix < 0x3ff3_0000 {
            if ix < 0x3fe6_0000 {
                id = 0;
                x = (2.0 * x - 1.0) / (2.0 + x);
            } else {
                id = 1;
                x = (x - 1.0) / (x + 1.0);
            }
        } else if ix < 0x4003_8000 {
            id = 2;
            x = (x - 1.5) / (1.0 + 1.5 * x);
        } else {
            id = 3;
            x = -1.0 / x;
        }
    }
    let z = x * x;
    let w = z * z;
    let s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
    let s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
    if id < 0 {
        x - x * (s1 + s2)
    } else {
        let id = id as usize;
        let z = ATANHI[id] - ((x * (s1 + s2) - ATANLO[id]) - x);
        if hx < 0 { -z } else { z }
    }
}

const TINY: f64 = 1.0e-300;
const PI_O_4: f64 = f64::from_bits(0x3fe9_21fb_5444_2d18);
const PI_O_2: f64 = f64::from_bits(0x3ff9_21fb_5444_2d18);
const PI_LO: f64 = f64::from_bits(0x3ca1_a626_3314_5c07);
const PI: f64 = std::f64::consts::PI;

/// `Math.atan2`, which delegates to `StrictMath.atan2` (`FdLibm.Atan2`).
pub fn atan2(y: f64, x: f64) -> f64 {
    let hx = hi(x);
    let ix = hx & EXP_SIGNIF_BITS;
    let lx = lo(x);
    let hy = hi(y);
    let iy = hy & EXP_SIGNIF_BITS;
    let ly = lo(y);
    if x.is_nan() || y.is_nan() {
        return x + y;
    }
    if (hx.wrapping_sub(0x3ff0_0000) | lx) == 0 {
        return atan(y); // x = 1.0
    }
    let m = ((hy >> 31) & 1) | ((hx >> 30) & 2); // 2*sign(x) + sign(y)

    if (iy | ly) == 0 {
        return match m {
            0 | 1 => y,
            2 => PI + TINY,
            _ => -PI - TINY,
        };
    }
    if (ix | lx) == 0 {
        return if hy < 0 { -PI_O_2 - TINY } else { PI_O_2 + TINY };
    }
    if ix == EXP_BITS {
        return if iy == EXP_BITS {
            match m {
                0 => PI_O_4 + TINY,
                1 => -PI_O_4 - TINY,
                2 => 3.0 * PI_O_4 + TINY,
                _ => -3.0 * PI_O_4 - TINY,
            }
        } else {
            match m {
                0 => 0.0,
                1 => -0.0,
                2 => PI + TINY,
                _ => -PI - TINY,
            }
        };
    }
    if iy == EXP_BITS {
        return if hy < 0 { -PI_O_2 - TINY } else { PI_O_2 + TINY };
    }

    let k = (iy - ix) >> 20;
    let z = if k > 60 {
        PI_O_2 + 0.5 * PI_LO
    } else if hx < 0 && k < -60 {
        0.0
    } else {
        atan((y / x).abs())
    };
    match m {
        0 => z,
        1 => -z,
        2 => PI - (z - PI_LO),
        _ => (z - PI_LO) - PI,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_is_exact_half_up() {
        assert_eq!(round(0.499_999_999_999_999_94), 0);
        assert_eq!(round(0.5), 1);
        assert_eq!(round(-0.5), 0);
        assert_eq!(round(-1.5), -1);
        assert_eq!(round(2.5), 3);
        assert_eq!(round(f64::NAN), 0);
        assert_eq!(round(1e300), i64::MAX);
        assert_eq!(round_f32(-2.5), -2);
        assert_eq!(round_f32(0.499_999_97), 0);
    }

    #[test]
    fn atan2_matches_fdlibm_values() {
        // Values printed by Java's StrictMath.atan2.
        assert_eq!(atan2(1.0, 1.0).to_bits(), 0x3fe9_21fb_5444_2d18);
        assert_eq!(atan2(0.0, -1.0), PI);
        assert_eq!(atan2(-0.0, 1.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(atan2(1.0, 0.0).to_bits(), PI_O_2.to_bits());
    }

    #[test]
    fn double_compare_orders_zero_and_nan() {
        assert_eq!(double_compare(-0.0, 0.0), Ordering::Less);
        assert_eq!(double_compare(f64::NAN, f64::INFINITY), Ordering::Greater);
        assert_eq!(double_compare(f64::NAN, -f64::NAN), Ordering::Equal);
    }
}

//! `Math.sin`, `Math.cos` and `Math.exp` as Java computes them on x86-64. HotSpot (and Graal) replace
//! them with stubs from Intel's LIBM (`stubGenerator_x86_64_{sin,cos,exp}.cpp`, mirrored in Graal's
//! `AMD64Math{Sin,Cos,Exp}Op`), whose results differ from the platform's libm in the last bit now and
//! then: on integer-degree round-trip angles, one call in ~300. A one-ulp difference can move a
//! round-trip waypoint by one coordinate unit, so the stubs are ported here instruction by instruction,
//! with SSE registers as two-lane values. Only IEEE double operations are used (no fused multiply-add),
//! so the results are the same on every platform.
//!
//! `sin` and `cos` take the stub's main path for |x| < 90112 and its tiny-argument path. Beyond that the
//! stub reduces the argument with a Payne-Hanek scheme, which is not ported: those inputs (angles of
//! millions of degrees) fall back to the platform functions.

/// One SSE register: lane 0 (`.0`) and lane 1 (`.1`). Scalar instructions (`*sd`) act on lane 0 only.
#[derive(Clone, Copy)]
struct Xmm(f64, f64);

fn d(bits: u64) -> f64 {
    f64::from_bits(bits)
}

impl Xmm {
    fn splat(v: f64) -> Self {
        Self(v, v)
    }
    fn addpd(self, o: Self) -> Self {
        Self(self.0 + o.0, self.1 + o.1)
    }
    fn subpd(self, o: Self) -> Self {
        Self(self.0 - o.0, self.1 - o.1)
    }
    fn mulpd(self, o: Self) -> Self {
        Self(self.0 * o.0, self.1 * o.1)
    }
    fn bits(self, f: impl Fn(u64, u64) -> u64, o: Self) -> Self {
        Self(d(f(self.0.to_bits(), o.0.to_bits())), d(f(self.1.to_bits(), o.1.to_bits())))
    }
    fn pand(self, o: Self) -> Self {
        self.bits(|a, b| a & b, o)
    }
    fn por(self, o: Self) -> Self {
        self.bits(|a, b| a | b, o)
    }
    fn lanes(self, f: impl Fn(u64) -> u64) -> Self {
        Self(d(f(self.0.to_bits())), d(f(self.1.to_bits())))
    }
    /// `paddd`/`psubd`: 32-bit integer lanes.
    fn dwords(self, f: impl Fn(u32, u32) -> u32, o: Self) -> Self {
        let lane = |a: f64, b: f64| {
            let (a, b) = (a.to_bits(), b.to_bits());
            let lo = f(a as u32, b as u32);
            let hi = f((a >> 32) as u32, (b >> 32) as u32);
            d(u64::from(hi) << 32 | u64::from(lo))
        };
        Self(lane(self.0, o.0), lane(self.1, o.1))
    }
}

/// `cvttsd2si` (32-bit): truncation, with 0x80000000 for NaN and out-of-range values.
fn cvttsd2si(v: f64) -> i32 {
    if v.is_nan() || v >= 2_147_483_648.0 || v < -2_147_483_648.0 { i32::MIN } else { v as i32 }
}

/// The upper 32 bits, where the stubs read the exponent (`[rsp+12]`, `pextrw ..., 3`).
fn high_word(v: f64) -> u32 {
    (v.to_bits() >> 32) as u32
}

const ONEHALF: u64 = 0x3fe0_0000_0000_0000;
const P1: u64 = 0x3fb9_21fb_5440_0000;
const P2: u64 = 0x3d90_b461_1a60_0000;
const P3: u64 = 0x3b63_198a_2e03_7073;
const PI32_INV: u64 = 0x4024_5f30_6dc9_c883;
const SIGN_MASK: u64 = 0x8000_0000_0000_0000;
const ALL_ONES: u64 = 0x3fef_ffff_ffff_ffff;

fn sc(lo: u64, hi: u64) -> Xmm {
    Xmm(d(lo), d(hi))
}

/// The registers the final summations of `sin` and `cos` read.
struct Reduced {
    x0: Xmm,
    x1: Xmm,
    x3: Xmm,
    x4: Xmm,
    x5: Xmm,
    x6: Xmm,
    x7: Xmm,
}

/// The main path's range reduction and table lookup, shared by `sin` and `cos`: they differ only in
/// the table index (`cos` adds a quarter turn, 16 of 64 steps) and the final summation.
fn reduce(x: f64, index_offset: i32) -> Reduced {
    let arg = Xmm(x, 0.0); // the upper lane of the argument never reaches lane 0
    let mut x1 = Xmm(d(PI32_INV), 0.0);
    x1.0 *= arg.0;
    x1 = x1.addpd(Xmm::splat(d(ONEHALF)).por(Xmm(d(SIGN_MASK), 0.0).pand(arg)));
    let n = cvttsd2si(x1.0); // N = x * 32/pi rounded half away from zero
    x1.0 = f64::from(n);
    let entry = (n.wrapping_add(index_offset) & 63) as usize * 4;
    let t = |i: usize| d(CTABLE[entry + i]);

    let mut x2 = Xmm::splat(d(P2));
    let mut x3 = Xmm(d(P1), 0.0);
    x3.0 *= x1.0; // m1 = N * P1
    x1 = Xmm::splat(x1.0);
    let mut x4 = arg;
    let mut x5 = sc(0x3ec7_1de3_a556_c734, 0x3efa_01a0_1a01_a01a); // SC_4
    x2 = x2.mulpd(x1); // m2 = N * P2
    let mut x0 = arg;
    x0.0 -= x3.0; // r1 = x - m1
    x1.0 *= d(P3); // m3 = N * P3
    x4.0 -= x3.0;
    let mut x7 = Xmm(t(1), 0.0);
    x0 = Xmm::splat(x0.0);
    x3 = x4;
    x4.0 -= x2.0; // r = r1 - m2
    x5 = x5.mulpd(x0);
    x0 = x0.subpd(x2);
    let mut x6 = sc(0x3f81_1111_1111_1111, 0x3fa5_5555_5555_5555); // SC_2
    x7.0 *= x4.0;
    x3.0 -= x4.0; // c1 = r1 - r
    x5 = x5.mulpd(x0);
    x0 = x0.mulpd(x0);
    x3.0 -= x2.0; // c2 = c1 - m2
    x2 = Xmm(t(0), t(1));
    x1.0 -= x3.0; // -c = m3 - c2
    x3 = Xmm(t(3), 0.0);
    x2.0 += x3.0;
    x7.0 -= x2.0;
    x2.0 *= x4.0;
    x6 = x6.mulpd(x0);
    x3.0 *= x4.0;
    x2 = x2.mulpd(x0);
    x0 = x0.mulpd(x0);
    x5 = x5.addpd(sc(0xbf2a_01a0_1a01_a01a, 0xbf56_c16c_16c1_6c17)); // SC_3
    x4.0 *= t(0);
    x6 = x6.addpd(sc(0xbfc5_5555_5555_5555, 0xbfe0_0000_0000_0000)); // SC_1
    x5 = x5.mulpd(x0);
    x0 = x3;
    x3.0 += t(1);
    x1 = x1.mulpd(x7);
    x7 = x4;
    x4.0 += x3.0;
    x6 = x6.addpd(x5);
    x5 = Xmm(t(1), 0.0);
    x5.0 -= x3.0;
    x3.0 -= x4.0;
    x1.0 += t(2);
    x6 = x6.mulpd(x2);
    Reduced { x0, x1, x3, x4, x5, x6, x7 }
}

/// The stubs' first check: `Some` outside the main path's 2^-252 <= |x| < 90112, with the value the
/// later branches test.
fn outside_main_path(x: f64) -> Option<u32> {
    let rax = (high_word(x) & 0x7fff_0000).wrapping_sub(0x3030_0000);
    (rax > 0x10c5_0000).then_some(rax)
}

/// Arguments beyond the main path: NaN for infinities and NaN (as `x * -0.0` in the stubs), the
/// platform function for finite ones (the stubs' Payne-Hanek reduction is not ported).
fn huge(x: f64, f: fn(f64) -> f64) -> f64 {
    if x.is_finite() { f(x) } else { x * -0.0 }
}

/// `Math.sin`.
pub fn sin(x: f64) -> f64 {
    if let Some(rax) = outside_main_path(x) {
        if rax as i32 > 0x10c5_0000 {
            return huge(x, f64::sin);
        }
        // |x| < 2^-252: zero and subnormals are scaled by 1 - 2^-53, the rest comes back unchanged
        return if rax >> 20 == 3325 { x * d(ALL_ONES) } else { x };
    }
    let Reduced { x0, mut x1, mut x3, x4, mut x5, x6, x7 } = reduce(x, 0);
    x5.0 += x0.0;
    x3.0 += x7.0;
    x1.0 += x5.0;
    x1.0 += x3.0;
    x1.0 += x6.0;
    x1.0 += x6.1;
    x4.0 + x1.0
}

/// `Math.cos`.
pub fn cos(x: f64) -> f64 {
    if let Some(rax) = outside_main_path(x) {
        if rax as i32 > 0x10c5_0000 {
            return huge(x, f64::cos);
        }
        return 1.0 - x.abs(); // |x| < 2^-252
    }
    let Reduced { mut x0, x1, mut x3, x4, x5, x6, x7 } = reduce(x, 16);
    x0.0 += x5.0;
    x3.0 += x7.0;
    x0.0 += x1.0;
    x0.0 += x3.0;
    x0.0 += x6.0;
    x0.0 += x6.1;
    x0.0 + x4.0
}

/// `psllq`: a shift count beyond 63 clears the lane.
fn psllq(v: Xmm, count: u64) -> Xmm {
    v.lanes(|b| if count > 63 { 0 } else { b << count })
}

fn paddq(a: Xmm, b: Xmm) -> Xmm {
    a.bits(u64::wrapping_add, b)
}

/// `Math.exp`.
pub fn exp(x: f64) -> f64 {
    let top = (x.to_bits() >> 48) as u32 & 0x7fff;
    if (16527u32.wrapping_sub(top) | top.wrapping_sub(15504)) >= 0x8000_0000 {
        return exp_outside(x); // |x| < 2^-54 or |x| >= 1024
    }
    let arg = Xmm::splat(x);
    let shifter = Xmm::splat(d(0x4338_0000_0000_0000));
    let mut x1 = Xmm::splat(d(0x4057_1547_652b_82fe)).mulpd(arg); // x * 64/ln 2
    x1 = x1.addpd(shifter);
    let mut x7 = x1;
    x1 = x1.subpd(shifter); // N, rounded to nearest
    let x2 = Xmm::splat(d(0x3f86_2e42_fefa_0000)).mulpd(x1);
    let mut x4 = sc(0x3f56_c15c_e328_9860, 0x3fa5_5555_555b_9e25);
    let x3 = Xmm::splat(d(0x3d1c_f79a_bc9e_3b3a)).mulpd(x1);
    let mut x5 = sc(0x3f81_1115_c090_cf0f, 0x3fc5_5555_5554_8ba1);
    let mut x0 = arg.subpd(x2);
    let low = x7.0.to_bits() as u32 as i32; // movdl: N in the low word
    let j = (low & 63) as usize;
    let n = low >> 6;
    x7 = x7.pand(Xmm::splat(d(0x0000_0000_ffff_ffc0)));
    x7 = paddq(x7, Xmm::splat(d(0x0000_0000_0000_ffc0)));
    x7 = psllq(x7, 46); // 2^n
    x0 = x0.subpd(x3); // r
    let mut x2 = Xmm(d(EXP_TABLE[2 * j]), d(EXP_TABLE[2 * j + 1]));
    x4 = x4.mulpd(x0);
    let mut x6 = x0;
    let mut x1 = x0;
    x6 = x6.mulpd(x6);
    x0 = x0.mulpd(x6);
    x5 = x5.addpd(x4);
    x0.0 *= x6.0;
    x6 = x6.mulpd(Xmm::splat(d(0x3fdf_ffff_ffff_fffe)));
    x1.0 += x2.0;
    x2 = Xmm::splat(x2.1);
    x0 = x0.mulpd(x5);
    x1.0 += x0.0;
    x2 = x2.por(x7);
    x0 = Xmm::splat(x0.1);
    x0.0 += x1.0;
    x0.0 += x6.0;
    if (n.wrapping_add(894) as u32) > 1916 {
        return exp_scaled(x0, x2, n);
    }
    x0.0 *= x2.0;
    x0.0 + x2.0
}

/// The stub's block for results whose exponent 2^n needs care: n < -894 (subnormal results) or
/// n > 1022 (overflow).
fn exp_scaled(mut x0: Xmm, mut x2: Xmm, n: i32) -> f64 {
    let ebias = Xmm::splat(d(0x3ff0_0000_0000_0000));
    let rdx = (-1022i32).wrapping_sub(n);
    let mut x4 = psllq(Xmm::splat(d(u64::MAX)), u64::from(rdx as u32));
    let half = n >> 1;
    let mut x3 = psllq(Xmm(d(u64::from(half as u16) << 48), 0.0), 4);
    x2 = x2.dwords(u32::wrapping_sub, x3);
    x0.0 *= x2.0;
    if rdx > 52 {
        x3 = x3.dwords(u32::wrapping_add, ebias);
        x0 = x0.addpd(x2);
        return x0.0 * x3.0;
    }
    x4 = x4.pand(x2);
    x3 = x3.dwords(u32::wrapping_add, ebias);
    x2.0 -= x4.0;
    x0.0 += x2.0;
    if n >= 1023 {
        return (x0.0 + x4.0) * x3.0; // overflows to infinity, or not
    }
    if rdx as u32 | (high_word(x0.0) >> 16 & 0x8000) == 0 {
        return (x0.0 + x4.0) * x3.0;
    }
    let mut x6 = x0;
    x0.0 += x4.0;
    x0.0 *= x3.0;
    if high_word(x0.0) >> 16 & 0x7ff0 != 0 {
        return x0.0;
    }
    // a subnormal result: redo the last steps in integer arithmetic for correct rounding
    x6.0 *= x3.0;
    x4.0 *= x3.0;
    let mut x0 = x6;
    let sign = (x6.0.to_bits() ^ x4.0.to_bits()) >> 63; // psrad 31 + pshufd 0x55: the sign of lane 0
    let mask = if sign != 0 { u64::MAX } else { 0 };
    x0 = x0.lanes(|b| (b << 1) >> 1);
    x0 = x0.lanes(|b| b ^ mask);
    x0 = paddq(x0, Xmm::splat(d(mask >> 63)));
    x0 = paddq(x0, x4);
    x0.0
}

/// The stub's paths for |x| < 2^-54 and |x| >= 1024.
fn exp_outside(x: f64) -> f64 {
    let hi = high_word(x);
    let magnitude = hi & 0x7fff_ffff;
    if magnitude < 0x4090_0000 {
        return x + 1.0;
    }
    if magnitude < 0x7ff0_0000 {
        return if hi >= 0x8000_0000 {
            d(0x0010_0000_0000_0000) * d(0x0010_0000_0000_0000)
        } else {
            f64::MAX * f64::MAX
        };
    }
    if magnitude > 0x7ff0_0000 || x.to_bits() as u32 != 0 {
        return x + x; // NaN
    }
    if hi != 0x7ff0_0000 { 0.0 } else { f64::INFINITY }
}

/// `Ctable`: per multiple of pi/32, four doubles (see the stub's algorithm description).
#[rustfmt::skip]
const CTABLE: [u64; 256] = [
    0x0000000000000000, 0x0000000000000000, 0x0000000000000000, 0x3ff0000000000000,
    0xbf73b92e176d6d31, 0x3fb917a6bc29b42c, 0xbc3e2718e0000000, 0x3ff0000000000000,
    0xbf93ad06011469fb, 0x3fc8f8b83c69a60b, 0xbc626d19c0000000, 0x3ff0000000000000,
    0xbfa60bea939d225a, 0x3fd294062ed59f06, 0xbc75d28da0000000, 0x3ff0000000000000,
    0xbfb37ca1866b95cf, 0x3fd87de2a6aea963, 0xbc672cede0000000, 0x3ff0000000000000,
    0xbfbe3a6873fa1279, 0x3fde2b5d3806f63b, 0x3c5e0d8920000000, 0x3ff0000000000000,
    0xbfc592675bc57974, 0x3fe1c73b39ae68c8, 0x3c8b25dd20000000, 0x3ff0000000000000,
    0xbfcd0dfe53aba2fd, 0x3fe44cf325091dd6, 0x3c68076a20000000, 0x3ff0000000000000,
    0x3fca827999fcef32, 0x3fe6a09e667f3bcd, 0xbc8bdd3420000000, 0x3fe0000000000000,
    0x3fc133cc94247758, 0x3fe8bc806b151741, 0xbc82c5e120000000, 0x3fe0000000000000,
    0x3fac73b39ae68c87, 0x3fea9b66290ea1a3, 0x3c39f630e0000000, 0x3fe0000000000000,
    0xbf9d4a2c7f909c4e, 0x3fec38b2f180bdb1, 0xbc76e0b180000000, 0x3fe0000000000000,
    0xbfbe087565455a75, 0x3fed906bcf328d46, 0x3c7457e620000000, 0x3fe0000000000000,
    0x3fa4a03176acf82d, 0x3fee9f4156c62dda, 0x3c8760b1e0000000, 0x3fd0000000000000,
    0xbfac1d1f0e5967d5, 0x3fef6297cff75cb0, 0x3c75621720000000, 0x3fd0000000000000,
    0xbf9ba1650f592f50, 0x3fefd88da3d12526, 0xbc887df640000000, 0x3fc0000000000000,
    0x0000000000000000, 0x3ff0000000000000, 0x0000000000000000, 0x0000000000000000,
    0x3f9ba1650f592f50, 0x3fefd88da3d12526, 0xbc887df640000000, 0xbfc0000000000000,
    0x3fac1d1f0e5967d5, 0x3fef6297cff75cb0, 0x3c75621720000000, 0xbfd0000000000000,
    0xbfa4a03176acf82d, 0x3fee9f4156c62dda, 0x3c8760b1e0000000, 0xbfd0000000000000,
    0x3fbe087565455a75, 0x3fed906bcf328d46, 0x3c7457e620000000, 0xbfe0000000000000,
    0x3f9d4a2c7f909c4e, 0x3fec38b2f180bdb1, 0xbc76e0b180000000, 0xbfe0000000000000,
    0xbfac73b39ae68c87, 0x3fea9b66290ea1a3, 0x3c39f630e0000000, 0xbfe0000000000000,
    0xbfc133cc94247758, 0x3fe8bc806b151741, 0xbc82c5e120000000, 0xbfe0000000000000,
    0xbfca827999fcef32, 0x3fe6a09e667f3bcd, 0xbc8bdd3420000000, 0xbfe0000000000000,
    0x3fcd0dfe53aba2fd, 0x3fe44cf325091dd6, 0x3c68076a20000000, 0xbff0000000000000,
    0x3fc592675bc57974, 0x3fe1c73b39ae68c8, 0x3c8b25dd20000000, 0xbff0000000000000,
    0x3fbe3a6873fa1279, 0x3fde2b5d3806f63b, 0x3c5e0d8920000000, 0xbff0000000000000,
    0x3fb37ca1866b95cf, 0x3fd87de2a6aea963, 0xbc672cede0000000, 0xbff0000000000000,
    0x3fa60bea939d225a, 0x3fd294062ed59f06, 0xbc75d28da0000000, 0xbff0000000000000,
    0x3f93ad06011469fb, 0x3fc8f8b83c69a60b, 0xbc626d19c0000000, 0xbff0000000000000,
    0x3f73b92e176d6d31, 0x3fb917a6bc29b42c, 0xbc3e2718e0000000, 0xbff0000000000000,
    0x0000000000000000, 0x0000000000000000, 0x0000000000000000, 0xbff0000000000000,
    0x3f73b92e176d6d31, 0xbfb917a6bc29b42c, 0x3c3e2718e0000000, 0xbff0000000000000,
    0x3f93ad06011469fb, 0xbfc8f8b83c69a60b, 0x3c626d19c0000000, 0xbff0000000000000,
    0x3fa60bea939d225a, 0xbfd294062ed59f06, 0x3c75d28da0000000, 0xbff0000000000000,
    0x3fb37ca1866b95cf, 0xbfd87de2a6aea963, 0x3c672cede0000000, 0xbff0000000000000,
    0x3fbe3a6873fa1279, 0xbfde2b5d3806f63b, 0xbc5e0d8920000000, 0xbff0000000000000,
    0x3fc592675bc57974, 0xbfe1c73b39ae68c8, 0xbc8b25dd20000000, 0xbff0000000000000,
    0x3fcd0dfe53aba2fd, 0xbfe44cf325091dd6, 0xbc68076a20000000, 0xbff0000000000000,
    0xbfca827999fcef32, 0xbfe6a09e667f3bcd, 0x3c8bdd3420000000, 0xbfe0000000000000,
    0xbfc133cc94247758, 0xbfe8bc806b151741, 0x3c82c5e120000000, 0xbfe0000000000000,
    0xbfac73b39ae68c87, 0xbfea9b66290ea1a3, 0xbc39f630e0000000, 0xbfe0000000000000,
    0x3f9d4a2c7f909c4e, 0xbfec38b2f180bdb1, 0x3c76e0b180000000, 0xbfe0000000000000,
    0x3fbe087565455a75, 0xbfed906bcf328d46, 0xbc7457e620000000, 0xbfe0000000000000,
    0xbfa4a03176acf82d, 0xbfee9f4156c62dda, 0xbc8760b1e0000000, 0xbfd0000000000000,
    0x3fac1d1f0e5967d5, 0xbfef6297cff75cb0, 0xbc75621720000000, 0xbfd0000000000000,
    0x3f9ba1650f592f50, 0xbfefd88da3d12526, 0x3c887df640000000, 0xbfc0000000000000,
    0x0000000000000000, 0xbff0000000000000, 0x0000000000000000, 0x0000000000000000,
    0xbf9ba1650f592f50, 0xbfefd88da3d12526, 0x3c887df640000000, 0x3fc0000000000000,
    0xbfac1d1f0e5967d5, 0xbfef6297cff75cb0, 0xbc75621720000000, 0x3fd0000000000000,
    0x3fa4a03176acf82d, 0xbfee9f4156c62dda, 0xbc8760b1e0000000, 0x3fd0000000000000,
    0xbfbe087565455a75, 0xbfed906bcf328d46, 0xbc7457e620000000, 0x3fe0000000000000,
    0xbf9d4a2c7f909c4e, 0xbfec38b2f180bdb1, 0x3c76e0b180000000, 0x3fe0000000000000,
    0x3fac73b39ae68c87, 0xbfea9b66290ea1a3, 0xbc39f630e0000000, 0x3fe0000000000000,
    0x3fc133cc94247758, 0xbfe8bc806b151741, 0x3c82c5e120000000, 0x3fe0000000000000,
    0x3fca827999fcef32, 0xbfe6a09e667f3bcd, 0x3c8bdd3420000000, 0x3fe0000000000000,
    0xbfcd0dfe53aba2fd, 0xbfe44cf325091dd6, 0xbc68076a20000000, 0x3ff0000000000000,
    0xbfc592675bc57974, 0xbfe1c73b39ae68c8, 0xbc8b25dd20000000, 0x3ff0000000000000,
    0xbfbe3a6873fa1279, 0xbfde2b5d3806f63b, 0xbc5e0d8920000000, 0x3ff0000000000000,
    0xbfb37ca1866b95cf, 0xbfd87de2a6aea963, 0x3c672cede0000000, 0x3ff0000000000000,
    0xbfa60bea939d225a, 0xbfd294062ed59f06, 0x3c75d28da0000000, 0x3ff0000000000000,
    0xbf93ad06011469fb, 0xbfc8f8b83c69a60b, 0x3c626d19c0000000, 0x3ff0000000000000,
    0xbf73b92e176d6d31, 0xbfb917a6bc29b42c, 0x3c3e2718e0000000, 0x3ff0000000000000,
];

/// 2^(j/64) for j = 0..63: a low-order correction and the high-order mantissa bits.
#[rustfmt::skip]
const EXP_TABLE: [u64; 128] = [
    0x0000000000000000, 0x0000000000000000, 0x3cad7bbf0e03754d, 0x00002c9a3e778060,
    0x3c8cd2523567f613, 0x000059b0d3158574, 0x3c60f74e61e6c861, 0x0000874518759bc8,
    0x3c979aa65d837b6c, 0x0000b5586cf9890f, 0x3c3ebe3d702f9cd1, 0x0000e3ec32d3d1a2,
    0x3ca3516e1e63bcd8, 0x00011301d0125b50, 0x3ca4c55426f0387b, 0x0001429aaea92ddf,
    0x3ca9515362523fb6, 0x000172b83c7d517a, 0x3c8b898c3f1353bf, 0x0001a35beb6fcb75,
    0x3c9aecf73e3a2f5f, 0x0001d4873168b9aa, 0x3c8a6f4144a6c38d, 0x0002063b88628cd6,
    0x3c968efde3a8a894, 0x0002387a6e756238, 0x3c80472b981fe7f2, 0x00026b4565e27cdd,
    0x3c82f7e16d09ab31, 0x00029e9df51fdee1, 0x3c8b3782720c0ab3, 0x0002d285a6e4030b,
    0x3c834d754db0abb6, 0x000306fe0a31b715, 0x3c8fdd395dd3f84a, 0x00033c08b26416ff,
    0x3ca12f8ccc187d29, 0x000371a7373aa9ca, 0x3ca7d229738b5e8b, 0x0003a7db34e59ff6,
    0x3c859f48a72a4c6d, 0x0003dea64c123422, 0x3ca8b846259d9205, 0x0004160a21f72e29,
    0x3c4363ed60c2ac12, 0x00044e086061892d, 0x3c6ecce1daa10379, 0x000486a2b5c13cd0,
    0x3c7690cebb7aafb0, 0x0004bfdad5362a27, 0x3ca083cc9b282a09, 0x0004f9b2769d2ca6,
    0x3ca509b0c1aae707, 0x0005342b569d4f81, 0x3c93350518fdd78e, 0x00056f4736b527da,
    0x3c9063e1e21c5409, 0x0005ab07dd485429, 0x3c9432e62b64c035, 0x0005e76f15ad2148,
    0x3ca0128499f08c0a, 0x0006247eb03a5584, 0x3c99f0870073dc06, 0x0006623882552224,
    0x3c998d4d0da05571, 0x0006a09e667f3bcc, 0x3ca52bb986ce4786, 0x0006dfb23c651a2e,
    0x3ca32092206f0dab, 0x00071f75e8ec5f73, 0x3ca061228e17a7a6, 0x00075feb564267c8,
    0x3ca244ac461e9f86, 0x0007a11473eb0186, 0x3c65ebe1abd66c55, 0x0007e2f336cf4e62,
    0x3c96fe9fbbff67d0, 0x00082589994cce12, 0x3c951f1414c801df, 0x000868d99b4492ec,
    0x3c8db72fc1f0eab4, 0x0008ace5422aa0db, 0x3c7bf68359f35f44, 0x0008f1ae99157736,
    0x3ca360ba9c06283c, 0x00093737b0cdc5e4, 0x3c95e8d120f962aa, 0x00097d829fde4e4f,
    0x3c71affc2b91ce27, 0x0009c49182a3f090, 0x3c9b6d34589a2ebd, 0x000a0c667b5de564,
    0x3c95277c9ab89880, 0x000a5503b23e255c, 0x3c8469846e735ab3, 0x000a9e6b5579fdbf,
    0x3c8c1a7792cb3387, 0x000ae89f995ad3ad, 0x3ca22466dc2d1d96, 0x000b33a2b84f15fa,
    0x3ca1112eb19505ae, 0x000b7f76f2fb5e46, 0x3c74ffd70a5fddcd, 0x000bcc1e904bc1d2,
    0x3c736eae30af0cb3, 0x000c199bdd85529c, 0x3c84e08fd10959ac, 0x000c67f12e57d14b,
    0x3c676b2c6c921968, 0x000cb720dcef9069, 0x3c93700936df99b3, 0x000d072d4a07897b,
    0x3c74a385a63d07a7, 0x000d5818dcfba487, 0x3c8e5a50d5c192ac, 0x000da9e603db3285,
    0x3c98bb731c4a9792, 0x000dfc97337b9b5e, 0x3c74b604603a88d3, 0x000e502ee78b3ff6,
    0x3c916f2792094926, 0x000ea4afa2a490d9, 0x3c8ec3bc41aa2008, 0x000efa1bee615a27,
    0x3c8a64a931d185ee, 0x000f50765b6e4540, 0x3c77893b4d91cd9d, 0x000fa7c1819e90d8,
];

#[cfg(test)]
mod tests {
    use super::*;

    type Case = (fn(f64) -> f64, u64, u64);

    /// Values Java printed where the platform's functions differ from HotSpot's.
    #[test]
    fn matches_hotspot() {
        let cases: [Case; 9] = [
            (sin, 0x4024_3eee_03e1_961a, 0xbfe4_91b7_523c_1615),
            (cos, 0x4027_c579_72e6_e21e, 0x3fe8_de61_3515_a323),
            (exp, 0xc070_bccc_cccc_cccd, 0x27c9_0ab5_534f_d4d6),
            (exp, 0x4083_dd96_d9a5_4a41, 0x7941_611b_a642_e47e),
            (exp, 0x405e_f5d2_9e3e_e263, 0x4b19_5d71_57e0_78c5),
            // results near and below the smallest normal double
            (exp, 0xc085_1828_f5c2_8f5c, 0x0311_c714_b243_85fd),
            (exp, 0xc086_f35c_28f5_c28f, 0x0000_0000_0000_57c9),
            (exp, 0xc087_ed88_ea4f_7093, 0),
            (sin, 0, 0),
        ];
        for (f, x, want) in cases {
            assert_eq!(f(d(x)).to_bits(), want, "{:e}", d(x));
        }
        assert_eq!(cos(0.0), 1.0);
        assert_eq!(exp(0.0), 1.0);
        assert!(sin(f64::INFINITY).is_nan() && exp(f64::NAN).is_nan());
        assert_eq!(exp(f64::NEG_INFINITY), 0.0);
        assert_eq!(exp(1000.0), f64::INFINITY);
    }
}

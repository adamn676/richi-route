//! The bits of the Java library whose exact behaviour reaches the router's results or output:
//! `Double.toString`, `DecimalFormat("0.###")`, `Double.parseDouble`, `Integer.parseInt`,
//! `URLDecoder.decode`, `String.split`, `String.hashCode`, `HashMap` iteration order and
//! `Math.min`/`Math.max`. `Float.toString` and `Float.parseFloat` come from the expressions crate.

use std::fmt;

pub use brouter_expressions::java::float_to_string;

/// A Java exception that escapes to the caller, printed like `Throwable.toString()`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JavaException {
    pub class: &'static str,
    pub message: Option<String>,
}

impl JavaException {
    pub fn new(class: &'static str, message: impl Into<String>) -> Self {
        Self { class, message: Some(message.into()) }
    }

    pub fn illegal_argument(message: impl Into<String>) -> Self {
        Self::new("java.lang.IllegalArgumentException", message)
    }

    pub fn number_format(message: impl Into<String>) -> Self {
        Self::new("java.lang.NumberFormatException", message)
    }
}

impl fmt::Display for JavaException {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.message {
            Some(m) => write!(f, "{}: {m}", self.class),
            None => f.write_str(self.class),
        }
    }
}

impl std::error::Error for JavaException {}

/// `Double.toString` as in JDK 19 and later: the shortest decimal that rounds back to the value (the
/// closest one when there are several, ties to an even digit; when the shortest has one digit, the
/// closest of all one- and two-digit decimals), written plain between 10^-3 and 10^7 and as
/// `d.dddE±n` otherwise.
pub fn double_to_string(v: f64) -> String {
    if v.is_nan() {
        return "NaN".to_string();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if v == 0.0 {
        return if v.is_sign_negative() { "-0.0" } else { "0.0" }.to_string();
    }
    if let Some(s) = quarter_to_string(v) {
        return s;
    }
    let (digits, exponent) = java_digits(v.abs());
    let mut out = String::with_capacity(24);
    if v < 0.0 {
        out.push('-');
    }
    if (-3..7).contains(&exponent) {
        if exponent >= 0 {
            let int_len = exponent as usize + 1;
            if digits.len() <= int_len {
                out.push_str(&digits);
                out.extend(std::iter::repeat_n('0', int_len - digits.len()));
                out.push_str(".0");
            } else {
                out.push_str(&digits[..int_len]);
                out.push('.');
                out.push_str(&digits[int_len..]);
            }
        } else {
            out.push_str("0.");
            out.extend(std::iter::repeat_n('0', (-exponent - 1) as usize));
            out.push_str(&digits);
        }
    } else {
        out.push_str(&digits[..1]);
        out.push('.');
        out.push_str(if digits.len() > 1 { &digits[1..] } else { "0" });
        out.push('E');
        out.push_str(&exponent.to_string());
    }
    out
}

/// `Double.toString` of a nonzero multiple of 1/4 below 2^20 (an elevation, `selev / 4.`): its exact
/// decimal, which no shorter decimal rounds to at that magnitude, written plain.
fn quarter_to_string(v: f64) -> Option<String> {
    let quarters = v * 4.0; // exact
    let k = quarters as i32;
    let q = k.unsigned_abs();
    if f64::from(k) != quarters || q >= 1 << 22 {
        return None;
    }
    let sign = if k < 0 { "-" } else { "" };
    Some(format!("{sign}{}.{}", q / 4, ["0", "25", "5", "75"][(q % 4) as usize]))
}

/// The digits Java's `Double.toString` chooses for a positive finite double: (`d1d2...`, exponent of
/// `d1`), without trailing zeros.
fn java_digits(v: f64) -> (String, i32) {
    let (digits, exponent) = shortest_digits(v);
    if digits.len() == 1 && v.is_subnormal() {
        closest_one_or_two_digits(v, digits, exponent)
    } else if let Some(even) = even_tie(v, &digits, exponent) {
        (even, exponent)
    } else {
        (digits, exponent)
    }
}

/// Rust's shortest round-trip digits of a positive double: (`d1d2...`, exponent of `d1`).
fn shortest_digits(v: f64) -> (String, i32) {
    let formatted = format!("{v:e}");
    let (mantissa, exponent) = formatted.split_once('e').expect("{:e} always has an exponent");
    (mantissa.replace('.', ""), exponent.parse().expect("{:e} writes a decimal exponent"))
}

/// Java breaks an exact tie between the two closest shortest decimals towards the even last digit;
/// Rust's shortest formatting rounds it up. A tie means the exact value has one digit more, a 5.
fn even_tie(v: f64, digits: &str, exponent: i32) -> Option<String> {
    // v = m 2^q with m odd has the exact expansion m 5^-q 10^q for q < 0, at most 18 digits long (one
    // more than the longest shortest form) only for q >= -25; for q >= 0, v is an integer, and an odd
    // one is exact while an even one cannot end in 5.
    let bits = v.to_bits();
    let (m, q) = if bits >> 52 == 0 {
        (bits, -1074)
    } else {
        ((bits & 0xf_ffff_ffff_ffff) | 0x10_0000_0000_0000, (bits >> 52) as i32 - 1075)
    };
    let (m, q) = (m >> m.trailing_zeros(), q + m.trailing_zeros() as i32);
    if !(-25..0).contains(&q) {
        return None;
    }
    let exact = (u128::from(m) * 5u128.pow(q.unsigned_abs())).to_string(); // ends in 5
    if exact.len() != digits.len() + 1 || exact.len() as i32 - 1 + q != exponent {
        return None;
    }
    let lower = &exact[..digits.len()];
    let last = lower.as_bytes()[lower.len() - 1];
    let even = if last % 2 == 0 {
        lower.to_string()
    } else if last == b'9' {
        return None; // the upper candidate would be shorter, and Rust would have found it
    } else {
        format!("{}{}", &lower[..lower.len() - 1], char::from(last + 1))
    };
    let rounds_back = format!("{even}e{}", exponent - digits.len() as i32 + 1).parse::<f64>() == Ok(v);
    (even != digits && rounds_back).then_some(even)
}

/// Java's rule for one-digit shortest forms: the closest decimal among all one- and two-digit
/// decimals that round to `v`. Only subnormals have rounding intervals wide enough for this to differ
/// from the shortest form. With v = m 2^-1074 and a candidate K 10^s, the distances compare exactly as
/// |K 2^1074 - m 10^-s| on a common scale s; they never tie.
fn closest_one_or_two_digits(v: f64, digits: String, exponent: i32) -> (String, i32) {
    let s = exponent - 2;
    let p = big(1, 2, 1074);
    let q = big(v.to_bits(), 10, (-s) as u32);
    let distance = |k: u32| {
        let mut kp = p.clone();
        big_mul(&mut kp, k);
        big_abs_diff(&kp, &q)
    };
    let d: u32 = digits.parse().expect("one digit");
    let mut best_distance = distance(d * 100);
    let mut best = (digits, exponent);
    for k in 10u32..=99 {
        // k 10^(exponent-1) and k 10^(exponent-2): their first digit sits at exponent and exponent - 1
        for (scale_exp, factor) in [(exponent - 1, 10), (exponent - 2, 1)] {
            if format!("{k}e{scale_exp}").parse::<f64>() != Ok(v) {
                continue;
            }
            let dist = distance(k * factor);
            if big_cmp(&dist, &best_distance).is_lt() {
                best_distance = dist;
                best = (k.to_string().trim_end_matches('0').to_string(), scale_exp + 1);
            }
        }
    }
    best
}

/// `start * base^exp` as a little-endian base-2^32 number, for `closest_one_or_two_digits`.
fn big(start: u64, base: u32, exp: u32) -> Vec<u32> {
    let mut r = vec![start as u32, (start >> 32) as u32];
    for _ in 0..exp {
        big_mul(&mut r, base);
    }
    r
}

fn big_mul(a: &mut Vec<u32>, x: u32) {
    let mut carry = 0u64;
    for limb in a.iter_mut() {
        let t = u64::from(*limb) * u64::from(x) + carry;
        *limb = t as u32;
        carry = t >> 32;
    }
    if carry > 0 {
        a.push(carry as u32);
    }
}

fn trimmed(a: &[u32]) -> &[u32] {
    let len = a.iter().rposition(|&l| l != 0).map_or(0, |i| i + 1);
    &a[..len]
}

fn big_cmp(a: &[u32], b: &[u32]) -> std::cmp::Ordering {
    let (a, b) = (trimmed(a), trimmed(b));
    a.len().cmp(&b.len()).then_with(|| a.iter().rev().cmp(b.iter().rev()))
}

fn big_abs_diff(a: &[u32], b: &[u32]) -> Vec<u32> {
    let (a, b) = if big_cmp(a, b).is_lt() { (b, a) } else { (a, b) };
    let mut borrow = 0i64;
    a.iter()
        .enumerate()
        .map(|(i, &limb)| {
            let t = i64::from(limb) - i64::from(b.get(i).copied().unwrap_or(0)) - borrow;
            borrow = i64::from(t < 0);
            (t + (borrow << 32)) as u32
        })
        .collect()
}

/// `DecimalFormat` with pattern `0.###` (`Locale.ENGLISH`, `HALF_EVEN`) applied to a float, which Java
/// widens to double. Java rounds the decimal digits `FloatingDecimal` makes of the double, deciding
/// ties by the exact value. For a float with a fraction (always below 2^23) no rounding boundary lies
/// between those digits and the exact value, so this is the exact value rounded to three decimals,
/// trailing zeros dropped; integers are written as `integer_digits` makes them.
pub fn format_0_000(v: f32) -> String {
    if v.is_nan() {
        return "NaN".to_string();
    }
    let sign = if v.is_sign_negative() { "-" } else { "" };
    if v.is_infinite() {
        return format!("{sign}\u{221e}");
    }
    if v.abs() >= 1.0 && v.fract() == 0.0 {
        return format!("{sign}{}", integer_digits(f64::from(v.abs())));
    }
    let bits = v.to_bits();
    let (m, e) = if (bits >> 23) & 0xff == 0 {
        (u128::from(bits & 0x7f_ffff), -149)
    } else {
        (u128::from((bits & 0x7f_ffff) | 0x80_0000), ((bits >> 23) & 0xff) as i32 - 150)
    };
    // v * 1000 = m * 1000 * 2^e, rounded half to even (e < 0: v has a fraction)
    let thousandths = if e > -100 {
        let k = -e as u32;
        let scaled = m * 1000;
        let q = scaled >> k;
        let r = scaled & ((1u128 << k) - 1);
        let half = 1u128 << (k - 1);
        if r > half || (r == half && q % 2 == 1) { q + 1 } else { q }
    } else {
        0 // below 2^-76: rounds to zero
    };
    let (int_part, frac) = (thousandths / 1000, thousandths % 1000);
    if frac == 0 {
        format!("{sign}{int_part}")
    } else {
        let frac = format!("{frac:03}");
        format!("{sign}{int_part}.{}", frac.trim_end_matches('0'))
    }
}

/// The digits of an integer-valued double as `FloatingDecimal` writes them for `DecimalFormat`: below
/// 2^63 the exact value with the "insignificant" low digits (as many as 2^(binExp - 54) has digits
/// beyond its first) rounded off half up (`developLongDigits`). Beyond 2^63 Java takes its general
/// digit generation, which is not ported (no time value comes near): the shortest digits stand in.
fn integer_digits(a: f64) -> String {
    let bin_exp = (a.to_bits() >> 52) as i32 - 1023;
    if bin_exp > 62 {
        let (digits, exponent) = java_digits(a);
        return format!("{digits}{}", "0".repeat(exponent as usize + 1 - digits.len()));
    }
    let p2 = bin_exp - 54;
    let insignificant = if (2..64).contains(&p2) { (1u64 << p2).to_string().len() - 1 } else { 0 };
    let value = a as i64;
    if insignificant == 0 {
        return value.to_string();
    }
    let pow10 = 10i64.pow(insignificant as u32);
    let rounded = value / pow10 + i64::from(value % pow10 >= pow10 / 2);
    format!("{rounded}{}", "0".repeat(insignificant))
}

/// `Double.parseDouble`. Errors carry the `NumberFormatException` message. Java's scanner (shared
/// with `Float.parseFloat`) validates the text; both languages then round correctly. Hexadecimal
/// floats, which Rust cannot parse, are rejected.
pub fn parse_double(s: &str) -> Result<f64, JavaException> {
    brouter_expressions::java::parse_float(s).map_err(JavaException::number_format)?;
    let t = s.trim_matches(|c: char| c <= ' ');
    let t = t.strip_suffix(['f', 'F', 'd', 'D']).unwrap_or(t);
    t.parse::<f64>().map_err(|_| JavaException::number_format(format!("For input string: \"{s}\"")))
}

/// `Integer.parseInt` (radix 10), for ASCII digits.
pub fn parse_int(s: &str) -> Result<i32, JavaException> {
    let error = || JavaException::number_format(format!("For input string: \"{s}\""));
    let (negative, digits) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(error());
    }
    let magnitude = digits.bytes().try_fold(0i64, |v, b| {
        let v = v * 10 + i64::from(b - b'0');
        (v <= 1 << 31).then_some(v)
    });
    let value = magnitude.ok_or_else(error)?;
    i32::try_from(if negative { -value } else { value }).map_err(|_| error())
}

/// `URLDecoder.decode(s, "UTF-8")`: `+` becomes a space, `%xx` sequences are decoded as UTF-8
/// (malformed bytes become U+FFFD). Like Java it walks UTF-16 units.
pub fn url_decode(s: &str) -> Result<String, JavaException> {
    let units: Vec<u16> = s.encode_utf16().collect();
    let n = units.len();
    let mut out: Vec<u16> = Vec::with_capacity(n);
    let mut i = 0;
    while i < n {
        match units[i] {
            0x2b => {
                out.push(0x20); // '+'
                i += 1;
            }
            0x25 => {
                let mut bytes = Vec::new();
                let mut c = units[i];
                while i + 2 < n && c == 0x25 {
                    bytes.push(parse_hex_byte(units[i + 1], units[i + 2])?);
                    i += 3;
                    if i < n {
                        c = units[i];
                    }
                }
                if i < n && c == 0x25 {
                    return Err(JavaException::illegal_argument("URLDecoder: Incomplete trailing escape (%) pattern"));
                }
                decode_utf8(&bytes, &mut out);
            }
            unit => {
                out.push(unit);
                i += 1;
            }
        }
    }
    Ok(String::from_utf16_lossy(&out))
}

/// `new String(bytes, UTF_8)` (`String.decodeUTF8_UTF16` with replacement): like Rust's lossy
/// decoding, except that a well-formed encoding of a surrogate becomes one U+FFFD and a truncated
/// sequence at the end one U+FFFD as a whole.
fn decode_utf8(src: &[u8], dst: &mut Vec<u16>) {
    const REPL: u16 = 0xfffd;
    let cont = |b: u8| b & 0xc0 == 0x80;
    let (mut sp, sl) = (0, src.len());
    while sp < sl {
        let b1 = src[sp];
        sp += 1;
        if b1 < 0x80 {
            dst.push(u16::from(b1));
        } else if b1 >> 5 == 0b110 && b1 & 0x1e != 0 {
            if sp < sl {
                let b2 = src[sp];
                if cont(b2) {
                    sp += 1;
                    dst.push((u16::from(b1 & 0x1f) << 6) | u16::from(b2 & 0x3f));
                } else {
                    dst.push(REPL);
                }
                continue;
            }
            dst.push(REPL);
            break;
        } else if b1 >> 4 == 0b1110 {
            let malformed_2 = |b2: u8| (b1 == 0xe0 && b2 & 0xe0 == 0x80) || !cont(b2);
            if sp + 1 < sl {
                let (b2, b3) = (src[sp], src[sp + 1]);
                dst.push(if malformed_2(b2) || !cont(b3) {
                    sp += if malformed_2(b2) { 0 } else { 1 };
                    REPL
                } else {
                    sp += 2;
                    let c = (u16::from(b1 & 0x0f) << 12) | (u16::from(b2 & 0x3f) << 6) | u16::from(b3 & 0x3f);
                    if (0xd800..0xe000).contains(&c) { REPL } else { c }
                });
                continue;
            }
            dst.push(REPL);
            if sp < sl && malformed_2(src[sp]) {
                continue;
            }
            break;
        } else if b1 >> 3 == 0b11110 {
            let malformed_2 = |b2: u8| {
                b1 > 0xf4
                    || (b1 == 0xf0 && !(0x90..=0xbf).contains(&b2))
                    || (b1 == 0xf4 && b2 & 0xf0 != 0x80)
                    || !cont(b2)
            };
            if sp + 2 < sl {
                let (b2, b3, b4) = (src[sp], src[sp + 1], src[sp + 2]);
                let uc = (u32::from(b1 & 0x07) << 18)
                    | (u32::from(b2 & 0x3f) << 12)
                    | (u32::from(b3 & 0x3f) << 6)
                    | u32::from(b4 & 0x3f);
                if !cont(b2) || !cont(b3) || !cont(b4) || !(0x1_0000..0x11_0000).contains(&uc) {
                    dst.push(REPL);
                    sp += if malformed_2(b2) {
                        0
                    } else if !cont(b3) {
                        1
                    } else {
                        2
                    };
                } else {
                    sp += 3;
                    let u = uc - 0x1_0000;
                    dst.extend([0xd800 | (u >> 10) as u16, 0xdc00 | (u & 0x3ff) as u16]);
                }
                continue;
            }
            dst.push(REPL);
            if sp < sl && malformed_2(src[sp]) {
                continue;
            }
            // a valid prefix: Java drops it with one replacement, and possibly the next byte too
            sp += 1;
            if sp < sl && !cont(src[sp]) {
                continue;
            }
            break;
        } else {
            dst.push(REPL);
        }
    }
}

/// `HexFormat.fromHexDigits(s, i + 1, i + 3)` as JDK 25's `URLDecoder` calls it, with its error message.
fn parse_hex_byte(first: u16, second: u16) -> Result<u8, JavaException> {
    let digit = |unit: u16| {
        char::from_u32(u32::from(unit)).and_then(|c| c.to_digit(16)).ok_or_else(|| {
            let c = char::from_u32(u32::from(unit)).unwrap_or(char::REPLACEMENT_CHARACTER);
            JavaException::illegal_argument(format!(
                "URLDecoder: Illegal hex characters in escape (%) pattern - not a hexadecimal digit: \"{c}\" = {unit}"
            ))
        })
    };
    Ok((digit(first)? * 16 + digit(second)?) as u8)
}

/// `String.split` with a separator class of single characters (`";|\\|"`, `","`): trailing empty
/// strings are dropped, an empty input gives one empty string.
pub fn split(s: &str, is_separator: impl Fn(char) -> bool) -> Vec<&str> {
    let mut parts: Vec<&str> = s.split(is_separator).collect();
    if !s.is_empty() {
        while parts.last() == Some(&"") {
            parts.pop();
        }
    }
    parts
}

/// `String.hashCode` over UTF-16 code units.
pub fn string_hash(s: &str) -> i32 {
    s.encode_utf16().fold(0i32, |h, c| h.wrapping_mul(31).wrapping_add(i32::from(c)))
}

/// The iteration order of a `java.util.HashMap` filled with these distinct keys in this order (and
/// possibly shrunk by removals afterwards, which change neither the table size nor the order): by
/// bucket of the spread hash, then by insertion. Buckets never hold the 8 keys that would make Java
/// treeify them for the handful of request parameters this is used for.
pub fn hash_map_order(keys: &[&str]) -> Vec<usize> {
    let mut capacity = 16usize;
    while keys.len() > capacity * 3 / 4 {
        capacity *= 2;
    }
    let bucket = |key: &str| {
        let h = string_hash(key) as u32;
        (h ^ (h >> 16)) as usize & (capacity - 1)
    };
    let mut order: Vec<usize> = (0..keys.len()).collect();
    order.sort_by_key(|&i| bucket(keys[i])); // stable: insertion order within a bucket
    order
}

/// `Math.min(float, float)`: NaN wins, and -0 is below +0.
pub fn min_f32(a: f32, b: f32) -> f32 {
    if a.is_nan() {
        return a;
    }
    if a == 0.0 && b == 0.0 && b.is_sign_negative() {
        return b;
    }
    if a <= b { a } else { b }
}

/// `Math.max(float, float)`.
pub fn max_f32(a: f32, b: f32) -> f32 {
    if a.is_nan() {
        return a;
    }
    if a == 0.0 && b == 0.0 && a.is_sign_negative() {
        return b;
    }
    if a >= b { a } else { b }
}

/// `Math.min(double, double)`.
pub fn min_f64(a: f64, b: f64) -> f64 {
    if a.is_nan() {
        return a;
    }
    if a == 0.0 && b == 0.0 && b.is_sign_negative() {
        return b;
    }
    if a <= b { a } else { b }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn double_to_string_follows_java() {
        let cases = [
            (1.0, "1.0"),
            (350.25, "350.25"),
            (-0.75, "-0.75"),
            (0.001, "0.001"),
            (1.0e-4, "1.0E-4"),
            (1234567.0, "1234567.0"),
            (1.0e7, "1.0E7"),
            (0.1, "0.1"),
            (1.0e23, "1.0E23"),
            (f64::MIN_POSITIVE, "2.2250738585072014E-308"),
            (f64::from_bits(1), "4.9E-324"),
            (f64::MAX, "1.7976931348623157E308"),
            (2.0f64.powi(-3), "0.125"),
            (-0.0, "-0.0"),
        ];
        for (v, text) in cases {
            assert_eq!(double_to_string(v), text, "{v:e}");
        }
    }

    #[test]
    fn decimal_format_rounds_half_even() {
        assert_eq!(format_0_000(0.0), "0");
        assert_eq!(format_0_000(12.0625), "12.062");
        assert_eq!(format_0_000(12.1875), "12.188");
        assert_eq!(format_0_000(0.1), "0.1");
        assert_eq!(format_0_000(1234.5677), "1234.568");
        assert_eq!(format_0_000(-0.0001), "-0");
        assert_eq!(format_0_000(3.0), "3");
    }

    #[test]
    fn parsers_follow_java() {
        assert_eq!(parse_double(" 15.4395 "), Ok(15.4395));
        assert_eq!(parse_double("1e3d"), Ok(1000.0));
        assert_eq!(parse_double("").unwrap_err().to_string(), "java.lang.NumberFormatException: empty String");
        assert_eq!(
            parse_double("x").unwrap_err().to_string(),
            "java.lang.NumberFormatException: For input string: \"x\""
        );
        assert_eq!(parse_int("-12"), Ok(-12));
        assert_eq!(parse_int("+7"), Ok(7));
        assert_eq!(parse_int("2147483648").unwrap_err().message.as_deref(), Some("For input string: \"2147483648\""));
        assert_eq!(parse_int("-2147483648"), Ok(i32::MIN));
        assert!(parse_int("-").is_err() && parse_int("").is_err() && parse_int("1.5").is_err());
    }

    #[test]
    fn url_decoding() {
        assert_eq!(url_decode("a%2Cb%7Cc+d"), Ok("a,b|c d".to_string()));
        assert_eq!(url_decode("%C3%A4"), Ok("\u{e4}".to_string()));
        assert_eq!(
            url_decode("%zz").unwrap_err().message.as_deref(),
            Some("URLDecoder: Illegal hex characters in escape (%) pattern - not a hexadecimal digit: \"z\" = 122")
        );
        assert!(url_decode("%+1").is_err());
        // Java: one replacement for an encoded surrogate and for a truncated sequence
        assert_eq!(url_decode("%ED%A0%80x"), Ok("\u{fffd}x".to_string()));
        assert_eq!(url_decode("%F0%9F%98"), Ok("\u{fffd}".to_string()));
        assert_eq!(url_decode("%F0%9F%98%80"), Ok("\u{1f600}".to_string()));
        assert_eq!(url_decode("%C0%AF%E2%82x"), Ok("\u{fffd}\u{fffd}\u{fffd}x".to_string()));
        assert_eq!(
            url_decode("a%2").unwrap_err().message.as_deref(),
            Some("URLDecoder: Incomplete trailing escape (%) pattern")
        );
    }

    #[test]
    fn hash_map_order_follows_buckets() {
        // "b" (98) and "a" (97) land in buckets 2 and 1
        assert_eq!(hash_map_order(&["b", "a"]), [1, 0]);
        // the order Java iterates a round-trip request's parameters in (16 keys: 32 buckets)
        let keys = [
            "/brouter",
            "profile",
            "lonlats",
            "format",
            "alternativeidx",
            "engineMode",
            "roundTripDistance",
            "direction",
            "roundTripPoints",
            "profile:pass1coefficient",
            "profile:pass2coefficient",
            "profile:richiroute_rules_0",
            "profile:richiroute_rules_1",
            "profile:richiroute_rules_2",
            "profile:richiroute_rules_3",
            "heading",
        ];
        let java = "heading profile format /brouter roundTripDistance roundTripPoints lonlats engineMode \
                    profile:richiroute_rules_2 alternativeidx profile:pass2coefficient profile:richiroute_rules_3 \
                    profile:pass1coefficient profile:richiroute_rules_0 profile:richiroute_rules_1 direction";
        let order: Vec<&str> = hash_map_order(&keys).into_iter().map(|i| keys[i]).collect();
        assert_eq!(order.join(" "), java.split_whitespace().collect::<Vec<_>>().join(" "));
        assert_eq!(string_hash("lonlats"), "lonlats".encode_utf16().fold(0i32, |h, c| h.wrapping_mul(31) + c as i32));
        assert_eq!(split("a;b|", |c| c == ';' || c == '|'), ["a", "b"]);
        assert!(split("||", |c| c == '|').is_empty());
    }
}

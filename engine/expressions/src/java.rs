//! The bits of the Java library the profile language depends on: `Float.parseFloat`, `Float.toString`,
//! `Short.parseShort`, `Character.isWhitespace`, `String.trim`, `String.split` and `BufferedReader.readLine`.
//! The two float conversions are public for the router's output formatting.

/// `Character.isWhitespace`: Unicode space separators except the non-breaking ones, plus the ASCII
/// controls `\t`..`\r` and `\u{1c}`..`\u{1f}`.
pub(crate) fn is_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r'
            | '\u{1c}'..='\u{1f}'
            | ' '
            | '\u{1680}'
            | '\u{2000}'..='\u{2006}'
            | '\u{2008}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{205f}'
            | '\u{3000}'
    )
}

/// `String.trim`: strips every character up to and including the space.
pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(|c: char| c <= ' ')
}

/// `String.split` on a single literal character: like Java it drops trailing empty strings, and an
/// empty input gives one empty string.
pub(crate) fn split(s: &str, separator: char) -> Vec<&str> {
    let mut parts: Vec<&str> = s.split(separator).collect();
    if !s.is_empty() {
        while parts.last() == Some(&"") {
            parts.pop();
        }
    }
    parts
}

/// `BufferedReader.readLine` over a whole text: lines end at `\n`, `\r` or `\r\n`.
pub(crate) fn lines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let bytes = text.as_bytes();
    let (mut start, mut i) = (0, 0);
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                lines.push(&text[start..i]);
                start = i + 1;
            }
            b'\r' => {
                lines.push(&text[start..i]);
                if bytes.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if start < bytes.len() {
        lines.push(&text[start..]);
    }
    lines
}

/// `Short.parseShort` (radix 10); the error is the `NumberFormatException` message.
pub(crate) fn parse_short(s: &str) -> Result<i16, String> {
    let digits = s.strip_prefix(['-', '+']).unwrap_or(s);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("For input string: \"{s}\""));
    }
    let magnitude = digits.bytes().try_fold(0i64, |v, b| v.checked_mul(10)?.checked_add(i64::from(b - b'0')));
    let value = magnitude.map(|m| if s.starts_with('-') { -m } else { m });
    match value.map(i32::try_from) {
        Some(Ok(v)) => i16::try_from(v).map_err(|_| format!("Value out of range. Value:\"{s}\" Radix:10")),
        _ => Err(format!("For input string: \"{s}\"")), // beyond int: Integer.parseInt fails first
    }
}

/// `Float.parseFloat`, ported from JDK 25's `FloatingDecimal.readJavaFormatString` scanner; the error
/// is the `NumberFormatException` message. Both languages round correctly, so the value itself comes
/// from Rust's parser (decimal) or an exact rounding (hexadecimal).
pub fn parse_float(input: &str) -> Result<f32, String> {
    // Java scans UTF-16 chars; scanning UTF-8 bytes is the same, since every test is against ASCII.
    let b = input.as_bytes();
    let len = b.len();
    let skip_whitespaces = |mut i: usize| {
        while i < len && b[i] <= b' ' {
            i += 1;
        }
        i
    };
    let check = |expected: bool| if expected { Ok(()) } else { Err(for_input_string(input)) };
    let check_multiple_points = |pt: usize, i: usize| if pt != 0 { Err("multiple points".to_string()) } else { Ok(i) };

    let mut i = skip_whitespaces(0);
    if i == len {
        return Err("empty String".to_string());
    }
    let negative = b[i] == b'-';
    if negative || b[i] == b'+' {
        i += 1;
    }
    let signed = |v: f32| if negative { -v } else { v };
    let mut is_dec = true;
    if i < len {
        let symbol = |name: &str| b[i..].starts_with(name.as_bytes()) && skip_whitespaces(i + name.len()) == len;
        match b[i] {
            b'I' => return check(symbol("Infinity")).map(|()| signed(f32::INFINITY)),
            b'N' => return check(symbol("NaN")).map(|()| f32::NAN), // ignores the sign
            b'0' if i < len - 1 && (b[i + 1] | 0x20) == b'x' => {
                is_dec = false;
                i += 2;
            }
            _ => {}
        }
    }
    let is_digit = |c: u8| c.is_ascii_digit() || (!is_dec && (b'a'..=b'f').contains(&(c | 0x20)));

    let mut pt = 0; // index after the point, 0 iff absent
    let start = i; // start of the significand
    while i < len && (b[i] == b'0' || b[i] == b'.') {
        i += 1;
        if b[i - 1] == b'.' {
            pt = check_multiple_points(pt, i)?;
        }
    }
    let mut nonzero = false;
    while i < len && (is_digit(b[i]) || b[i] == b'.') {
        i += 1;
        if b[i - 1] == b'.' {
            pt = check_multiple_points(pt, i)?;
        } else if b[i - 1] != b'0' {
            nonzero = true;
        }
    }
    check(i - start > usize::from(pt != 0))?; // at least one digit
    let stop = i;

    // The exponent: optional for decimal, mandatory for hexadecimal, clamped at 10^10.
    let mut exponent = 0i64;
    let mut has_exponent = false;
    if i < len && ((b[i] | 0x20) == b'e' && is_dec || (b[i] | 0x20) == b'p' && !is_dec) {
        i += 1;
        let mut exponent_sign = b' ';
        if i < len && (b[i] == b'-' || b[i] == b'+') {
            exponent_sign = b[i];
            i += 1;
        }
        while i < len && b[i].is_ascii_digit() {
            exponent = if exponent < 1_000_000_000 { 10 * exponent + i64::from(b[i] - b'0') } else { 10_000_000_000 };
            i += 1;
        }
        check(i - stop >= 3 || i - stop == 2 && exponent_sign == b' ')?;
        if exponent_sign == b'-' {
            exponent = -exponent;
        }
        has_exponent = true;
    }
    check(is_dec || has_exponent)?;
    if i < len && matches!(b[i] | 0x20, b'f' | b'd') {
        i += 1;
    }
    check(skip_whitespaces(i) == len)?;

    if !nonzero {
        return Ok(signed(0.0));
    }
    let significand = &input[start..stop];
    let value = if is_dec {
        format!("{significand}e{exponent}").parse::<f32>().map_err(|_| for_input_string(input))?
    } else {
        hex_value(significand, exponent)
    };
    Ok(signed(value))
}

/// Java's message for malformed input, which quotes the input as given (shortened beyond 1000 chars).
fn for_input_string(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    if chars.len() > 1000 {
        let head: String = chars[..497].iter().collect();
        let tail: String = chars[chars.len() - 498..].iter().collect();
        return format!("For input string: \"{head} ... {tail}\"");
    }
    format!("For input string: \"{input}\"")
}

/// The value of a scanned hexadecimal significand (hex digits and at most one point) times
/// `2^exponent`, correctly rounded.
fn hex_value(significand: &str, exponent: i64) -> f32 {
    let (int_part, frac_part) = significand.split_once('.').unwrap_or((significand, ""));
    let mut binary_exponent = exponent - 4 * frac_part.len() as i64;
    // Up to 16 significant hex digits go into the mantissa; the rest only count as sticky bits.
    let (mut mantissa, mut sticky, mut n) = (0u64, false, 0);
    for c in int_part.chars().chain(frac_part.chars()) {
        let digit = u64::from(c.to_digit(16).expect("scanned hex digit"));
        if n == 0 && digit == 0 {
            continue; // leading zero
        }
        if n < 16 {
            mantissa = mantissa << 4 | digit;
        } else {
            sticky |= digit != 0;
            binary_exponent += 4;
        }
        n += 1;
    }
    round_to_f32(mantissa, binary_exponent, sticky)
}

/// Rounds `mantissa * 2^exponent` (plus a sticky fraction below the mantissa) to the nearest `f32`,
/// ties to even, with subnormals.
fn round_to_f32(mantissa: u64, exponent: i64, sticky: bool) -> f32 {
    if mantissa == 0 {
        return 0.0;
    }
    let leading_zeros = mantissa.leading_zeros();
    let mantissa = u128::from(mantissa << leading_zeros);
    let top = exponent - i64::from(leading_zeros) + 63; // exponent of the leading bit
    if top > 127 {
        return f32::INFINITY;
    }
    let kept_bits = if top >= -126 { 24 } else { top + 150 };
    if kept_bits < 0 {
        return 0.0;
    }
    let shift = 64 - kept_bits as u32;
    let mut kept = mantissa >> shift;
    let rest = mantissa & ((1u128 << shift) - 1);
    let half = 1u128 << (shift - 1);
    if rest > half || (rest == half && (sticky || kept & 1 == 1)) {
        kept += 1;
    }
    if top < -126 {
        // Subnormal bit patterns are contiguous with the normal ones, so a carry into bit 23 is right.
        return f32::from_bits(kept as u32);
    }
    let (kept, top) = if kept == 1 << 24 { (kept >> 1, top + 1) } else { (kept, top) };
    if top > 127 {
        return f32::INFINITY;
    }
    f32::from_bits((((top + 127) as u32) << 23) | (kept as u32 & 0x7f_ffff))
}

/// `Float.toString` as in JDK 19 and later: the shortest decimal that rounds back to the value (the
/// closest one when there are several, ties to an even digit; when the shortest has one digit, the
/// closest of all one- and two-digit decimals), written plain between 10^-3 and 10^7 and as
/// `d.dddE±n` otherwise.
pub fn float_to_string(v: f32) -> String {
    if v.is_nan() {
        return "NaN".to_string();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if v == 0.0 {
        return if v.is_sign_negative() { "-0.0" } else { "0.0" }.to_string();
    }
    let (mut digits, mut exponent) = shortest_digits(v.abs());
    if digits.len() == 1 && v.is_subnormal() {
        (digits, exponent) = closest_one_or_two_digits(v.abs(), digits, exponent);
    } else if let Some(even) = even_tie(v.abs(), &digits, exponent) {
        digits = even;
    }
    let mut out = String::with_capacity(16);
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

/// Java breaks an exact tie between the two closest shortest decimals towards the even last digit;
/// Rust's shortest formatting rounds it up. A tie means the exact value has one digit more, a 5.
fn even_tie(v: f32, digits: &str, exponent: i32) -> Option<String> {
    // v = m 2^q with m odd has the exact decimal expansion m 5^-q 10^q for q < 0, which is short enough
    // to tie only for q >= -12; for q >= 0, v is an integer and its shortest form is exact.
    let bits = v.to_bits();
    let (m, q) =
        if bits >> 23 == 0 { (bits, -149) } else { ((bits & 0x7f_ffff) | 0x80_0000, (bits >> 23) as i32 - 150) };
    let (m, q) = (m >> m.trailing_zeros(), q + m.trailing_zeros() as i32);
    if !(-12..0).contains(&q) {
        return None;
    }
    let exact = (u64::from(m) * 5u64.pow(q.unsigned_abs())).to_string(); // ends in 5
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
    let rounds_back = format!("{even}e{}", exponent - digits.len() as i32 + 1).parse::<f32>() == Ok(v);
    (even != digits && rounds_back).then_some(even)
}

/// Rust's shortest round-trip digits of a positive float: (`d1d2...`, exponent of `d1`).
fn shortest_digits(v: f32) -> (String, i32) {
    let formatted = format!("{v:e}");
    let (mantissa, exponent) = formatted.split_once('e').expect("{:e} always has an exponent");
    (mantissa.replace('.', ""), exponent.parse().expect("{:e} writes a decimal exponent"))
}

/// Java's rule for one-digit shortest forms: choose the closest decimal among all one- and two-digit
/// decimals that round to `v`. Only subnormals have rounding intervals wide enough for this to differ
/// from the shortest form. Distances are compared in `f64`, where `v` is exact; they never tie.
fn closest_one_or_two_digits(v: f32, digits: String, exponent: i32) -> (String, i32) {
    let exact = f64::from(v);
    let distance = |text: &str| (text.parse::<f64>().unwrap_or(f64::MAX) - exact).abs();
    let mut best_distance = distance(&format!("{digits}e{exponent}"));
    let mut best = (digits, exponent);
    for scale in [exponent - 1, exponent - 2] {
        let center = (exact / 10f64.powi(scale)).round() as i64;
        for k in (center - 1).max(10)..=(center + 1).min(99) {
            let text = format!("{k}e{scale}");
            if text.parse::<f32>() == Ok(v) && distance(&text) < best_distance {
                best_distance = distance(&text);
                best = (k.to_string().trim_end_matches('0').to_string(), scale + 1);
            }
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_float_follows_java() {
        assert_eq!(parse_float(" 7 "), Ok(7.0));
        assert_eq!(parse_float("1f"), Ok(1.0));
        assert_eq!(parse_float("-2.5D"), Ok(-2.5));
        assert_eq!(parse_float(".5"), Ok(0.5));
        assert_eq!(parse_float("5."), Ok(5.0));
        assert_eq!(parse_float("1e3"), Ok(1000.0));
        assert_eq!(parse_float("+Infinity"), Ok(f32::INFINITY));
        assert!(parse_float("-NaN").unwrap().is_nan());
        assert_eq!(parse_float("0x1.8p1f"), Ok(3.0));
        assert_eq!(parse_float("0x.8p-149"), Ok(0.0)); // half of the smallest subnormal: ties to even
        assert_eq!(parse_float("0x.8000001p-149"), Ok(f32::from_bits(1)));
        assert_eq!(parse_float("6110849102116547607"), Ok(6.110_849e18));
        assert_eq!(parse_float(""), Err("empty String".into()));
        assert_eq!(parse_float("1.2.3"), Err("multiple points".into()));
        for bad in ["abc", "1e", "1e+", "0x1", "0x1p", "-", ".", "1_0", "1.5dd", "Infinity1", "inf", "nan", " x "] {
            assert_eq!(parse_float(bad), Err(format!("For input string: \"{bad}\"")), "{bad}");
        }
        assert_eq!(parse_float("0x1.2.3p1"), Err("multiple points".into()));
    }

    #[test]
    fn float_to_string_follows_java() {
        let cases = [
            (1.0, "1.0"),
            (0.001, "0.001"),
            (1234567.0, "1234567.0"),
            (12345678.0, "1.2345678E7"),
            (1.0e10, "1.0E10"),
            (0.3, "0.3"),
            (12.34, "12.34"),
            (-0.0, "-0.0"),
            (1.0e-4, "1.0E-4"),
            (f32::MIN_POSITIVE, "1.1754944E-38"),
            (f32::from_bits(1), "1.4E-45"),
            (f32::from_bits(21), "2.9E-44"), // the closest two-digit decimal beats the one-digit 3.0E-44
            (f32::from_bits(0x4825_8908), "169508.12"), // 169508.125: a tie goes to the even digit
            (f32::MAX, "3.4028235E38"),
        ];
        for (v, text) in cases {
            assert_eq!(float_to_string(v), text);
        }
    }

    #[test]
    fn small_parsers() {
        assert_eq!(parse_short("11"), Ok(11));
        assert_eq!(parse_short("99999"), Err("Value out of range. Value:\"99999\" Radix:10".into()));
        assert_eq!(parse_short(""), Err("For input string: \"\"".into()));
        assert_eq!(split("a|b||", '|'), ["a", "b"]);
        assert_eq!(split("", '|'), [""]);
        assert!(split("||", '|').is_empty());
        assert_eq!(lines("a\r\nb\rc\n\nd"), ["a", "b", "c", "", "d"]);
        assert!(is_whitespace('\u{1f}') && !is_whitespace('\u{a0}') && !is_whitespace('\u{85}'));
    }
}

//! Just enough JSON for the engine's GeoJSON, the planner's requests and the answers to them. Numbers
//! are read and written as JavaScript reads and writes them: the nearest double, and the shortest
//! digits that read back as the same double.

use std::fmt::Write;

#[derive(Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

const MAX_DEPTH: usize = 64;

impl Json {
    pub fn parse(text: &str) -> Result<Json, String> {
        let mut parser = Parser { bytes: text.as_bytes(), at: 0 };
        let value = parser.value(0)?;
        parser.space();
        if parser.at < parser.bytes.len() {
            return Err(parser.error("end of input"));
        }
        Ok(value)
    }

    /// An object's member; as in `JSON.parse`, the last of equal keys.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(members) => members.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn array(&self) -> Option<&[Json]> {
        if let Json::Array(items) = self { Some(items) } else { None }
    }

    pub fn str(&self) -> Option<&str> {
        if let Json::String(s) = self { Some(s) } else { None }
    }

    pub fn number(&self) -> Option<f64> {
        if let Json::Number(n) = self { Some(*n) } else { None }
    }

    /// JavaScript's `Number(value)` for the values the engine writes: numbers, decimal strings, `null`
    /// and booleans; anything else is NaN.
    pub fn to_number(&self) -> f64 {
        match self {
            Json::Number(n) => *n,
            Json::Null | Json::Bool(false) => 0.0,
            Json::Bool(true) => 1.0,
            Json::String(s) => {
                let s = s.trim_matches(|c: char| c.is_ascii_whitespace());
                match s {
                    "" => 0.0,
                    "Infinity" | "+Infinity" => f64::INFINITY,
                    "-Infinity" => f64::NEG_INFINITY,
                    _ if s.bytes().all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b)) => {
                        s.parse().unwrap_or(f64::NAN)
                    }
                    _ => f64::NAN,
                }
            }
            Json::Array(_) | Json::Object(_) => f64::NAN,
        }
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn error(&self, expected: &str) -> String {
        format!("JSON: expected {expected} at byte {}", self.at)
    }

    fn space(&mut self) {
        while self.bytes.get(self.at).is_some_and(|b| b" \t\n\r".contains(b)) {
            self.at += 1;
        }
    }

    fn eat(&mut self, byte: u8) -> bool {
        self.space();
        let found = self.bytes.get(self.at) == Some(&byte);
        self.at += usize::from(found);
        found
    }

    fn word(&mut self, word: &str, value: Json) -> Result<Json, String> {
        if self.bytes[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(self.error("a value"))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, String> {
        if depth > MAX_DEPTH {
            return Err(self.error("less nesting"));
        }
        self.space();
        match self.bytes.get(self.at) {
            Some(b'{') => {
                self.at += 1;
                let mut members = Vec::new();
                if !self.eat(b'}') {
                    loop {
                        self.space();
                        let key = self.string()?;
                        if !self.eat(b':') {
                            return Err(self.error("':'"));
                        }
                        members.push((key, self.value(depth + 1)?));
                        if self.eat(b'}') {
                            break;
                        }
                        if !self.eat(b',') {
                            return Err(self.error("',' or '}'"));
                        }
                    }
                }
                Ok(Json::Object(members))
            }
            Some(b'[') => {
                self.at += 1;
                let mut items = Vec::new();
                if !self.eat(b']') {
                    loop {
                        items.push(self.value(depth + 1)?);
                        if self.eat(b']') {
                            break;
                        }
                        if !self.eat(b',') {
                            return Err(self.error("',' or ']'"));
                        }
                    }
                }
                Ok(Json::Array(items))
            }
            Some(b'"') => self.string().map(Json::String),
            Some(b't') => self.word("true", Json::Bool(true)),
            Some(b'f') => self.word("false", Json::Bool(false)),
            Some(b'n') => self.word("null", Json::Null),
            _ => self.number(),
        }
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.at;
        let digits = |p: &mut Self| {
            let from = p.at;
            while p.bytes.get(p.at).is_some_and(u8::is_ascii_digit) {
                p.at += 1;
            }
            p.at > from
        };
        self.at += usize::from(self.bytes.get(self.at) == Some(&b'-'));
        let leading_zero = self.bytes.get(self.at) == Some(&b'0');
        if !digits(self) || (leading_zero && self.at - start > 1 + usize::from(self.bytes[start] == b'-')) {
            return Err(self.error("a value"));
        }
        if self.bytes.get(self.at) == Some(&b'.') {
            self.at += 1;
            if !digits(self) {
                return Err(self.error("digits"));
            }
        }
        if self.bytes.get(self.at).is_some_and(|b| *b == b'e' || *b == b'E') {
            self.at += 1;
            self.at += usize::from(self.bytes.get(self.at).is_some_and(|b| *b == b'+' || *b == b'-'));
            if !digits(self) {
                return Err(self.error("digits"));
            }
        }
        // only ASCII digits and signs between start and here
        let text = std::str::from_utf8(&self.bytes[start..self.at]).map_err(|_| self.error("a number"))?;
        text.parse().map(Json::Number).map_err(|_| self.error("a number"))
    }

    fn string(&mut self) -> Result<String, String> {
        if self.bytes.get(self.at) != Some(&b'"') {
            return Err(self.error("a string"));
        }
        self.at += 1;
        let mut s = String::new();
        loop {
            let run = self.at;
            while self.bytes.get(self.at).is_some_and(|b| *b != b'"' && *b != b'\\' && *b >= 0x20) {
                self.at += 1;
            }
            // the input is a str and the run ends at an ASCII byte, so it is whole characters
            s.push_str(std::str::from_utf8(&self.bytes[run..self.at]).map_err(|_| self.error("UTF-8"))?);
            match self.bytes.get(self.at) {
                Some(b'"') => {
                    self.at += 1;
                    return Ok(s);
                }
                Some(b'\\') => {
                    self.at += 1;
                    let escaped = self.bytes.get(self.at).copied();
                    self.at += 1;
                    match escaped {
                        Some(b'"') => s.push('"'),
                        Some(b'\\') => s.push('\\'),
                        Some(b'/') => s.push('/'),
                        Some(b'b') => s.push('\u{8}'),
                        Some(b'f') => s.push('\u{c}'),
                        Some(b'n') => s.push('\n'),
                        Some(b'r') => s.push('\r'),
                        Some(b't') => s.push('\t'),
                        Some(b'u') => {
                            let unit = self.hex4()?;
                            let pair = (0xd800..0xdc00).contains(&unit) && self.bytes[self.at..].starts_with(b"\\u");
                            let code = if pair {
                                let at = self.at;
                                self.at += 2;
                                match self.hex4()? {
                                    low @ 0xdc00..0xe000 => 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00),
                                    _ => {
                                        self.at = at;
                                        unit
                                    }
                                }
                            } else {
                                unit
                            };
                            s.push(char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER));
                        }
                        _ => return Err(self.error("an escape")),
                    }
                }
                _ => return Err(self.error("'\"'")),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let digits = self.bytes.get(self.at..self.at + 4).ok_or_else(|| self.error("four hex digits"))?;
        // from_str_radix would take a leading '+'
        let unit = digits.iter().all(u8::is_ascii_hexdigit).then(|| std::str::from_utf8(digits).ok()).flatten();
        let unit = unit.and_then(|d| u32::from_str_radix(d, 16).ok());
        self.at += 4;
        unit.ok_or_else(|| self.error("four hex digits"))
    }
}

/// A number as `JSON.stringify` writes it, apart from the exponent JavaScript uses below 1e-6 and from
/// 1e21: both read back as the same double. Not finite: `null`.
pub fn push_number(out: &mut String, n: f64) {
    if n.is_finite() {
        let _ = write!(out, "{n}");
    } else {
        out.push_str("null");
    }
}

pub fn push_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c < ' ' => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_what_the_engine_and_the_planner_write() {
        let json = Json::parse(r#" {"a": [1, -2.5e3, "x\"\u00e9\ud83d\udeb2", true, null], "a": {"b": []}} "#).unwrap();
        assert_eq!(json.get("a"), Some(&Json::Object(vec![("b".into(), Json::Array(vec![]))])));
        let Json::Object(members) = &json else { panic!() };
        let items = members[0].1.array().unwrap();
        assert_eq!(items[1].number(), Some(-2500.0));
        assert_eq!(items[2].str(), Some("x\"é🚲"));
        for bad in ["", "[1,]", "{\"a\" 1}", "01", "1.", "\"\u{1}\"", "[1] 2", "tru", "\"\\u+041\""] {
            assert!(Json::parse(bad).is_err(), "{bad}");
        }
        assert!(Json::parse(&"[".repeat(100)).is_err());
    }

    #[test]
    fn numbers_read_and_write_like_javascript() {
        assert_eq!(Json::parse("15.439328").unwrap().number(), Some(15_439_328.0 / 1e6));
        assert_eq!(Json::String(" 12 ".into()).to_number(), 12.0);
        assert_eq!(Json::String(String::new()).to_number(), 0.0);
        assert!(Json::String("12a".into()).to_number().is_nan());
        assert!(Json::String("inf".into()).to_number().is_nan());
        let mut out = String::new();
        for n in [0.1 + 0.2, 30.0, -0.5, f64::NAN] {
            push_number(&mut out, n);
            out.push(' ');
        }
        push_string(&mut out, "Süd\"\n");
        assert_eq!(out, "0.30000000000000004 30 -0.5 null \"Süd\\\"\\u000a\"");
    }
}

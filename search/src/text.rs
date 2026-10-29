//! Text as the search compares it: lower case, accents and umlauts on their base letter, ß as ss, split into words.

/// `text` folded for comparison.
pub fn fold(text: &str) -> String {
    let mut folded = String::with_capacity(text.len());
    for c in text.chars().flat_map(char::to_lowercase) {
        match c {
            'ä' | 'á' | 'à' | 'â' | 'ã' | 'å' | 'ą' => folded.push('a'),
            'ö' | 'ó' | 'ò' | 'ô' | 'õ' | 'ő' | 'ø' => folded.push('o'),
            'ü' | 'ú' | 'ù' | 'û' | 'ű' | 'ů' => folded.push('u'),
            'é' | 'è' | 'ê' | 'ë' | 'ę' | 'ě' => folded.push('e'),
            'í' | 'ì' | 'î' | 'ï' => folded.push('i'),
            'č' | 'ć' | 'ç' => folded.push('c'),
            'š' | 'ś' => folded.push('s'),
            'ž' | 'ź' | 'ż' => folded.push('z'),
            'đ' => folded.push('d'),
            'ñ' | 'ń' | 'ň' => folded.push('n'),
            'ř' => folded.push('r'),
            'ý' => folded.push('y'),
            'ł' => folded.push('l'),
            'ß' => folded.push_str("ss"),
            _ => folded.push(c),
        }
    }
    folded
}

/// The folded words of `text`; anything but letters and digits separates them ("Kaiser-Josef-Platz", "St.").
pub fn words(text: &str) -> Vec<String> {
    fold(text).split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

/// A word with umlauts written out ("koeflach") read with them ("koflach"), when it has any.
pub fn umlauts_written_out(word: &str) -> Option<String> {
    let read = word.replace("ae", "a").replace("oe", "o").replace("ue", "u");
    (read != word).then_some(read)
}

/// A house number as compared: "5 a", "5A" and "5a" are one.
pub fn house_number(text: &str) -> String {
    fold(text).chars().filter(|c| !c.is_whitespace()).collect()
}

/// Whether `word` is a house number or postcode rather than a word: digits, optionally a letter or more digits after.
pub fn is_number(word: &str) -> bool {
    word.starts_with(|c: char| c.is_ascii_digit()) && word.len() <= 6
}

/// The longest word, in bytes, that `distance_within` compares.
pub const MAX_WORD: usize = 63;

/// Whether `text` is house number `number` (as `house_number` gives it), without allocating for the usual one.
pub fn same_house_number(text: Option<&str>, number: &str) -> bool {
    text.is_some_and(|text| {
        match text.bytes().any(|b| !b.is_ascii() || b.is_ascii_uppercase() || b.is_ascii_whitespace()) {
            false => text == number,
            true => house_number(text) == number,
        }
    })
}

/// Edit distance between `a` and `b` counting a swap of neighbours as one edit, or `None` beyond `limit` (words of
/// up to `MAX_WORD` bytes).
pub fn distance_within(a: &[u8], b: &[u8], limit: usize) -> Option<usize> {
    if a.len().abs_diff(b.len()) > limit || a.len() > MAX_WORD || b.len() > MAX_WORD {
        return None;
    }
    // each edit changes at most two letters' counts
    let mut counts = [0i8; 256];
    a.iter().for_each(|&c| counts[usize::from(c)] += 1);
    b.iter().for_each(|&c| counts[usize::from(c)] -= 1);
    let mut differing = 0;
    for &c in a.iter().chain(b) {
        differing += counts[usize::from(c)].unsigned_abs() as usize;
        counts[usize::from(c)] = 0;
    }
    if differing > 2 * limit {
        return None;
    }
    let mut rows = [[0u8; MAX_WORD + 1]; 3];
    for (j, cell) in rows[0].iter_mut().enumerate().take(b.len() + 1) {
        *cell = j as u8;
    }
    for i in 1..=a.len() {
        // row i, and the rows of i - 1 and i - 2
        let (current, previous, before) = (i % 3, (i + 2) % 3, (i + 1) % 3);
        rows[current][0] = i as u8;
        let mut row_best = i as u8;
        for j in 1..=b.len() {
            let cost = u8::from(a[i - 1] != b[j - 1]);
            let mut value = (rows[previous][j] + 1).min(rows[current][j - 1] + 1).min(rows[previous][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                value = value.min(rows[before][j - 2] + 1);
            }
            rows[current][j] = value;
            row_best = row_best.min(value);
        }
        if usize::from(row_best) > limit {
            return None;
        }
    }
    Some(usize::from(rows[a.len() % 3][b.len()])).filter(|&d| d <= limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_and_splits() {
        assert_eq!(words("Kaiser-Josef-Platz"), ["kaiser", "josef", "platz"]);
        assert_eq!(words("Groß St. Florian"), ["gross", "st", "florian"]);
        assert_eq!(fold("Köflach Murska Sobota Žalec"), "koflach murska sobota zalec");
        assert_eq!(umlauts_written_out("koeflach").as_deref(), Some("koflach"));
        assert_eq!(house_number("5 A"), "5a");
    }

    #[test]
    fn counts_edits() {
        assert_eq!(distance_within(b"gleisdrof", b"gleisdorf", 1), Some(1));
        assert_eq!(distance_within(b"juddenburg", b"judenburg", 1), Some(1));
        assert_eq!(distance_within(b"shockl", b"schockl", 1), Some(1));
        assert_eq!(distance_within(b"leibniz", b"leibnitz", 1), Some(1));
        assert_eq!(distance_within(b"graz", b"wien", 2), None);
        assert_eq!(distance_within(b"weiz", b"weiz", 1), Some(0));
        assert_eq!(distance_within(b"kirchberg", b"purberg", 2), None);
    }
}

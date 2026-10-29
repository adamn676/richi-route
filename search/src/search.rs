//! Finding places by what was typed, and naming a point on the map.

use std::collections::{HashMap, HashSet};

use crate::geo::{Point, distance_km, distance_to_segment_km, in_bbox};
use crate::index::{Doc, House, Index, LISTS, List};
use crate::text::{MAX_WORD, distance_within, house_number, is_number, same_house_number, umlauts_written_out, words};

/// How much importance counts against distance unless asked otherwise: the planner's balance.
pub const DEFAULT_BIAS_SCALE: f64 = 0.5;

/// What was asked.
pub struct Query<'a> {
    pub text: &'a str,
    pub focus: Option<Point>,
    /// 0 to 1, as Photon's `location_bias_scale`: how much a place's importance still counts against its distance.
    pub bias_scale: f64,
    /// West, south, east, north.
    pub bbox: Option<[f64; 4]>,
    pub limit: usize,
}

/// A place found: a place of the index, or a house of one of its streets.
#[derive(Clone, Copy)]
pub enum Hit {
    Doc(u32),
    House(u32),
}

/// How well one typed word matched a place: in its name, in another of its names, and around it.
#[derive(Clone, Copy, Default)]
struct WordMatch {
    name: f32,
    other_name: f32,
    context: f32,
}

/// How much a word of another name (an old or local name) counts against the same word in the name.
const OTHER_NAME: f32 = 0.9;

/// The index's terms by length and first letter, and by length and second and third letter, to look for typos
/// among words of about the same length: a typo rarely hits the first letter and one of the next two.
pub struct TypoIndex {
    first: Vec<Vec<u32>>,
    second: HashMap<(usize, u8, u8), Vec<u32>>,
}

fn bucket(length: usize, letter: u8) -> usize {
    length.min(MAX_WORD) * 256 + usize::from(letter)
}

impl TypoIndex {
    pub fn new(index: &Index) -> TypoIndex {
        let mut typos = TypoIndex { first: vec![Vec::new(); 64 * 256], second: HashMap::new() };
        for (i, term) in index.terms.iter().enumerate() {
            let bytes = term.as_bytes();
            typos.first[bucket(bytes.len(), bytes[0])].push(i as u32);
            if let [_, second, third, ..] = *bytes {
                typos.second.entry((bytes.len().min(MAX_WORD), second, third)).or_default().push(i as u32);
            }
        }
        typos
    }
}

/// The terms a typed word stands for, with how well each matches: the word itself (also with its umlauts written out),
/// for the last word what it begins (it may still be being typed), and words one or two letters off.
fn term_matches(index: &Index, typos: &TypoIndex, word: &str, last: bool) -> Vec<(usize, f32)> {
    let mut found: HashMap<usize, f32> = HashMap::new();
    let mut add = |term: usize, quality: f32| {
        let best = found.entry(term).or_default();
        *best = best.max(quality);
    };
    let forms = std::iter::once(word.to_string()).chain(umlauts_written_out(word)).chain(written_out(word));
    for form in forms {
        if let Some(term) = index.term(&form) {
            add(term, 1.0);
        }
        if last && form.chars().count() >= 2 {
            let range = index.terms_with_prefix(&form);
            if range.len() <= 20_000 {
                for term in range {
                    let share = form.len() as f32 / index.terms[term].len() as f32;
                    add(term, 0.6 + 0.35 * share);
                }
            }
        }
        if form.chars().count() >= 4 {
            let typed = form.as_bytes();
            let limit = if typed.len() >= 8 { 2 } else { 1 };
            for length in typed.len().saturating_sub(limit)..=(typed.len() + limit).min(MAX_WORD) {
                let same_first = &typos.first[bucket(length, typed[0])];
                // the first letter mistyped: the same second and third (a typed word has four letters or more)
                let same_next = typos.second.get(&(length, typed[1], typed[2])).map_or(&[][..], Vec::as_slice);
                let same_next = same_next.iter().filter(|&&t| index.terms[t as usize].as_bytes()[0] != typed[0]);
                for &term in same_first.iter().chain(same_next) {
                    let text = index.terms[term as usize].as_bytes();
                    if let Some(edits @ 1..) = distance_within(typed, text, limit) {
                        add(term as usize, if edits == 1 { 0.75 } else { 0.6 });
                    }
                }
            }
        }
    }
    found.into_iter().collect()
}

/// A common abbreviation written out, or the other way round: Hbf, Bhf, Gr., St. and Sankt, Str. (also at the end of
/// a word, "Annenstr.").
fn written_out(word: &str) -> Option<String> {
    let other = match word {
        "hbf" => "hauptbahnhof",
        "bhf" => "bahnhof",
        "gr" => "gross",
        "st" => "sankt",
        "sankt" => "st",
        "str" => "strasse",
        _ => return word.strip_suffix("str").filter(|stem| stem.len() >= 3).map(|stem| format!("{stem}strasse")),
    };
    Some(other.to_string())
}

/// Places matching one typed word (or two run together), with how well; only those in `wanted` when given.
fn word_matches(index: &Index, terms: &[(usize, f32)], wanted: Option<&HashSet<u32>>) -> HashMap<u32, WordMatch> {
    let mut docs: HashMap<u32, WordMatch> = HashMap::new();
    for &(term, quality) in terms {
        for list in LISTS {
            for &doc in index.postings(term, list).iter().filter(|d| wanted.is_none_or(|w| w.contains(d))) {
                let m = docs.entry(doc).or_default();
                let best = match list {
                    List::Name => &mut m.name,
                    List::OtherName => &mut m.other_name,
                    List::Context => &mut m.context,
                };
                *best = best.max(quality);
            }
        }
    }
    docs
}

/// How many places a typed word's terms list, to start from the rarest.
fn postings(index: &Index, terms: &[(usize, f32)]) -> usize {
    terms.iter().flat_map(|&(t, _)| LISTS.map(|list| index.postings(t, list).len())).sum()
}

/// Each typed word's matches, among the places that have one of the `seeds` rarest words (or two words run together,
/// "Stubenberg See" for "Stubenbergsee"); with how many typed words each place has.
fn matching(
    index: &Index,
    words: &[Vec<(usize, f32)>],
    typed: &[&String],
    seeds: usize,
) -> (Vec<HashMap<u32, WordMatch>>, HashMap<u32, usize>) {
    let mut order: Vec<usize> = (0..words.len()).collect();
    order.sort_by_cached_key(|&i| postings(index, &words[i]));
    let mut matches: Vec<HashMap<u32, WordMatch>> = vec![HashMap::new(); words.len()];
    for &i in order.iter().take(seeds) {
        matches[i] = word_matches(index, &words[i], None);
    }
    let joined: Vec<(usize, HashMap<u32, WordMatch>)> = (1..typed.len())
        .filter_map(|i| index.term(&format!("{}{}", typed[i - 1], typed[i])).map(|t| (i, t)))
        .map(|(i, term)| (i, word_matches(index, &[(term, 1.0)], None)))
        .collect();
    let wanted: HashSet<u32> = order
        .iter()
        .take(seeds)
        .flat_map(|&i| matches[i].keys())
        .chain(joined.iter().flat_map(|(_, m)| m.keys()))
        .copied()
        .collect();
    for &i in order.iter().skip(seeds) {
        matches[i] = word_matches(index, &words[i], Some(&wanted));
    }
    for (i, found) in joined {
        for (&doc, m) in &found {
            for j in [i - 1, i] {
                let best = matches[j].entry(doc).or_default();
                (best.name, best.other_name) = (best.name.max(m.name), best.other_name.max(m.other_name));
            }
        }
    }
    let mut candidates: HashMap<u32, usize> = HashMap::new();
    for m in &matches {
        for &doc in m.keys() {
            *candidates.entry(doc).or_default() += 1;
        }
    }
    (matches, candidates)
}

/// The house with `number` on the street `doc`.
fn house(index: &Index, doc: &Doc, number: &str) -> Option<u32> {
    (doc.houses.0..doc.houses.1).find(|&h| same_house_number(index.text(index.houses[h as usize].number), number))
}

pub fn search(index: &Index, typos: &TypoIndex, query: &Query) -> Vec<(Hit, f64)> {
    // a house number keeps its range or part ("12-14", "5/1"); a letter after a number belongs to it ("7 A" is 7a)
    let mut tokens: Vec<String> = Vec::new();
    let chunk_words = query.text.split(|c: char| c.is_whitespace() || c == ',').flat_map(|chunk| {
        let number = chunk.starts_with(|c: char| c.is_ascii_digit())
            && chunk.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '/'))
            && chunk.contains(['-', '/']);
        if number { vec![house_number(chunk)] } else { words(chunk) }
    });
    for word in chunk_words {
        match tokens.last_mut() {
            Some(last) if word.chars().count() == 1 && word.chars().all(char::is_alphabetic) && is_number(last) => {
                last.push_str(&word);
            }
            _ => tokens.push(word),
        }
    }
    let (numbers, typed): (Vec<&String>, Vec<&String>) = tokens.iter().partition(|t| is_number(t));
    // a postcode is four or five digits that places have around them (Austria, Germany, Italy)
    let postcode = numbers.iter().find(|n| {
        (4..=5).contains(&n.len())
            && n.chars().all(|c| c.is_ascii_digit())
            && index.term(n).is_some_and(|t| !index.postings(t, List::Context).is_empty())
    });
    let number = numbers.iter().find(|n| Some(*n) != postcode).map(|n| house_number(n));
    let postcode = postcode.map(|p| p.as_str());
    // the last word may still be being typed, unless a space or a number follows it
    let ends_typing = !query.text.ends_with(char::is_whitespace) && tokens.last().is_some_and(|t| !is_number(t));

    let words: Vec<Vec<(usize, f32)>> = typed
        .iter()
        .enumerate()
        .map(|(i, word)| term_matches(index, typos, word, ends_typing && i == typed.len() - 1))
        .collect();
    // places with every word typed; when they are few, also those missing one, which must have one of the two
    // rarest words
    let scored = |missing| score(index, query, &typed, number.as_deref(), postcode, &words, missing);
    let mut hits = scored(0);
    if hits.len() < 5 && typed.len() >= 2 {
        hits = scored(1);
    }
    // equal scores in a fixed order
    let id = |hit: &Hit| match *hit {
        Hit::Doc(d) => (0, d),
        Hit::House(h) => (1, h),
    };
    hits.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| id(&a.0).cmp(&id(&b.0))));
    hits.truncate(query.limit);
    hits
}

/// The places with all words typed but `missing`, scored.
fn score(
    index: &Index,
    query: &Query,
    typed: &[&String],
    number: Option<&str>,
    postcode: Option<&str>,
    words: &[Vec<(usize, f32)>],
    allowed_missing: usize,
) -> Vec<(Hit, f64)> {
    let (matches, mut candidates) = matching(index, words, typed, allowed_missing + 1);
    if typed.is_empty()
        && let Some(postcode) = postcode
    {
        // a postcode alone stands for its towns
        let term = index.term(postcode).unwrap();
        for &doc in index.postings(term, List::Context) {
            if index.kinds[index.docs[doc as usize].kind as usize].kind_type != "street" {
                candidates.insert(doc, 0);
            }
        }
    }
    // words typed with umlauts or ß, as written: a name written so ("Brünn") fits better than one without (Brunn)
    let lowered = query.text.to_lowercase();
    let written: Vec<&str> = lowered.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_ascii()).collect();
    let lengths: Vec<f32> = typed.iter().map(|w| w.chars().count() as f32).collect();
    let total_length: f32 = lengths.iter().sum::<f32>().max(1.0);
    let distance_weight = 1.0 - query.bias_scale.clamp(0.0, 1.0);
    let number_term = number.and_then(|n| index.term(n));
    let postcode_term = postcode.and_then(|p| index.term(p));

    let mut hits: Vec<(Hit, f64)> = Vec::new();
    for (&doc_id, &count) in &candidates {
        let missing = typed.len() - count;
        if missing > allowed_missing {
            continue;
        }
        let doc = &index.docs[doc_id as usize];
        let point = doc.point();
        if query.bbox.is_some_and(|bbox| !in_bbox(point, bbox)) {
            continue;
        }
        // exact: every word typed is a word of its name (not only of another name)
        let (mut text, mut in_name, mut exact) = (0.0f32, 0.0f32, true);
        for (i, m) in matches.iter().enumerate() {
            let m = m.get(&doc_id).copied().unwrap_or_default();
            let name = m.name.max(m.other_name * OTHER_NAME);
            text += lengths[i] * name.max(m.context * 0.95);
            in_name += name;
            exact &= m.name >= 0.9;
        }
        if !typed.is_empty() && in_name == 0.0 {
            continue;
        }
        let complete = (in_name / f32::from(doc.name_words)).min(1.0);
        let mut score = 1.5 * f64::from(text / total_length) + f64::from(complete) + 1.5 * f64::from(doc.importance)
            - missing as f64;
        if exact && in_name >= f32::from(doc.name_words) && missing == 0 {
            score += 0.5;
        }
        if !written.is_empty()
            && let Some(name) = index.text(doc.name)
        {
            let name = name.to_lowercase();
            if written.iter().all(|w| name.split(|c: char| !c.is_alphanumeric()).any(|n| n == *w)) {
                score += 0.3;
            }
        }
        let mut hit = Hit::Doc(doc_id);
        if let Some(number) = number {
            if let Some(h) = house(index, doc, number) {
                hit = Hit::House(h);
                score += 1.0;
            } else if same_house_number(index.text(doc.housenumber), number) {
                score += 0.3;
            } else if !number_term.is_some_and(|t| index.postings(t, List::Name).binary_search(&doc_id).is_ok()) {
                score -= 0.2;
            }
        }
        if let Some(postcode) = postcode {
            // a postcode typed rules out other postcodes almost completely: a house's own, or any of a place's
            let fits = match hit {
                Hit::House(h) => index.text(index.houses[h as usize].postcode) == Some(postcode),
                Hit::Doc(_) => {
                    postcode_term.is_some_and(|t| index.postings(t, List::Context).binary_search(&doc_id).is_ok())
                }
            };
            score += if fits { 0.5 } else { -1.5 };
        }
        if let Some(focus) = query.focus {
            let at = match hit {
                Hit::House(h) => index.houses[h as usize].point(),
                Hit::Doc(_) => point,
            };
            score -= distance_weight * (1.0 + distance_km(focus, at) / 5.0).ln();
        }
        hits.push((hit, score));
    }
    hits
}

/// What lies at a point set on the map: the house there, or the road, or else the nearest house.
pub enum Spot<'a> {
    House(&'a House),
    Road { name: &'a str, near: Option<&'a House>, at: Point },
}

pub fn reverse(index: &Index, p: Point, radius_km: f64) -> Option<Spot<'_>> {
    let house = index.nearest_house(p, radius_km);
    let road = index.segment_grid.nearest(p, radius_km, |i| {
        let (a, b) = index.segments[i as usize].ends();
        distance_to_segment_km(p, a, b)
    });
    match (house, road) {
        (Some((h, dh)), Some((_, dr))) if dh <= 0.03 || dh <= dr + 0.01 => Some(Spot::House(&index.houses[h as usize])),
        (_, Some((s, _))) => {
            let near = index.nearest_house(p, 2.0);
            Some(Spot::Road {
                name: index.text(index.segments[s as usize].name).unwrap_or_default(),
                near: near.map(|(h, _)| &index.houses[h as usize]),
                at: p,
            })
        }
        (Some((h, _)), None) => Some(Spot::House(&index.houses[h as usize])),
        (None, None) => None,
    }
}

/// The municipality (or abroad, the town) around a point.
pub fn town_at(index: &Index, p: Point, radius_km: f64) -> Option<&str> {
    if let Some((h, _)) = index.nearest_house(p, radius_km.min(3.0)) {
        let street = &index.docs[index.houses[h as usize].street as usize];
        return index.text(street.city);
    }
    index
        .town_grid
        .nearest(p, radius_km, |i| distance_km(p, index.docs[i as usize].point()))
        .and_then(|(i, _)| index.text(index.docs[i as usize].name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::Builder;

    /// A register of two municipalities: Graz with Herrengasse and Annenstraße, and Gleisdorf with its Hauptplatz.
    fn index(test: &str) -> Index {
        let dir = std::env::temp_dir().join(format!("richi-search-{test}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, text: &str| std::fs::write(dir.join(format!("{name}.csv")), text).unwrap();
        write("GEMEINDE", "\u{feff}GKZ;GEMEINDENAME\n\"60101\";\"Graz\"\n\"61708\";\"Gleisdorf\"\n");
        write(
            "ORTSCHAFT",
            "GKZ;OKZ;ORTSNAME\n\"60101\";\"1\";\"Graz,01.Bez.:Innere Stadt\"\n\"61708\";\"2\";\"Gleisdorf\"\n",
        );
        write(
            "STRASSE",
            "SKZ;STRASSENNAME;STRASSENNAMENZUSATZ;SZUSADRBEST;GKZ;ZUSTELLORT;ZUSTELLORT_ID\n\
             \"1\";\"Herrengasse\";\"\";0;\"60101\";\"Graz\";\"1\"\n\
             \"2\";\"Annenstraße\";\"\";0;\"60101\";\"Graz\";\"1\"\n\
             \"3\";\"Hauptplatz\";\"\";0;\"61708\";\"Gleisdorf\";\"2\"\n",
        );
        // Herrengasse 5 in Graz is the register's own; the others lie nearby in the same zone (EPSG 31256)
        write(
            "ADRESSE",
            "ADRCD;GKZ;OKZ;PLZ;SKZ;HNR_ADR_ZUSAMMEN;RW;HW;EPSG\n\
             \"1\";\"60101\";\"1\";\"8010\";\"1\";\"5\";-67814.24;214994.63;31256\n\
             \"2\";\"60101\";\"1\";\"8010\";\"1\";\"7a\";-67800.00;215010.00;31256\n\
             \"3\";\"60101\";\"1\";\"8020\";\"2\";\"10\";-68500.00;215000.00;31256\n\
             \"5\";\"60101\";\"1\";\"8020\";\"2\";\"3-5\";-68400.00;215000.00;31256\n\
             \"4\";\"61708\";\"2\";\"8200\";\"3\";\"1\";-46100.00;218600.00;31256\n",
        );
        let mut builder = Builder::new();
        builder.add_register(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        builder.finish(Vec::new())
    }

    fn first(index: &Index, text: &str) -> Option<String> {
        let query = Query { text, focus: Some((15.44, 47.07)), bias_scale: 0.5, bbox: None, limit: 5 };
        search(index, &TypoIndex::new(index), &query).first().map(|(hit, _)| match *hit {
            Hit::Doc(d) => index.text(index.docs[d as usize].name).unwrap().to_string(),
            Hit::House(h) => {
                let house = &index.houses[h as usize];
                let street = index.text(index.docs[house.street as usize].name).unwrap();
                format!("{street} {}, {}", index.text(house.number).unwrap(), index.text(house.postcode).unwrap())
            }
        })
    }

    #[test]
    fn finds_houses_streets_and_typos() {
        let index = index("words");
        assert_eq!(first(&index, "Herrengasse 5").as_deref(), Some("Herrengasse 5, 8010"));
        assert_eq!(first(&index, "herrengasse 7 A").as_deref(), Some("Herrengasse 7a, 8010"));
        assert_eq!(first(&index, "Annenstr. 10").as_deref(), Some("Annenstraße 10, 8020"));
        assert_eq!(first(&index, "Annenstraße 3-5").as_deref(), Some("Annenstraße 3-5, 8020"));
        assert_eq!(first(&index, "Annenstraße 8020").as_deref(), Some("Annenstraße"));
        assert_eq!(first(&index, "Herreng").as_deref(), Some("Herrengasse"));
        assert_eq!(first(&index, "Herrengase").as_deref(), Some("Herrengasse"));
        assert_eq!(first(&index, "Hauptplatz Gleisdorf").as_deref(), Some("Hauptplatz"));
        assert_eq!(first(&index, "Hauptplatz 1 8200").as_deref(), Some("Hauptplatz 1, 8200"));
        assert_eq!(first(&index, "Opernring"), None);
    }

    #[test]
    fn names_points_on_the_map() {
        let index = index("map");
        let Some(Spot::House(house)) = reverse(&index, (15.4394, 47.0706), 0.3) else { panic!("no house") };
        assert_eq!(index.text(house.number), Some("5"));
        assert!(reverse(&index, (15.0, 47.5), 0.3).is_none());
        assert_eq!(town_at(&index, (15.4394, 47.0706), 3.0), Some("Graz"));
    }
}

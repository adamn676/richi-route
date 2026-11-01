//! The rider's road preferences, learned from their own rides (`experiments/strava/`): a cost factor per
//! directed way section, below 1 where the rider took the section when it came up, above 1 where they passed
//! it by. A link takes the factor of the section the search enters it by (the first in travel direction, the
//! last when searching from the destination; along a link they agree but where a trace began or ended); links
//! without one cost as the profile says.
//!
//! The prepared file, tab-separated: a header line `richiroute-preferences`, `1`, then one section per line:
//! the from and to positions as BRouter's integer longitude and latitude, and the factor.

use std::collections::HashMap;
use std::path::Path;

use brouter_mapaccess::Pos;
use brouter_util::FxBuildHasher;

/// A factor outside this range would let one section outweigh the profile altogether.
const FACTORS: std::ops::RangeInclusive<f32> = 0.1..=10.0;

pub struct Preferences {
    factors: HashMap<(Pos, Pos), f32, FxBuildHasher>,
    /// One bit per hash of a section's start: most links start where no section does, and the bit says
    /// so without a look into the big table.
    starts: Vec<u64>,
    /// The lowest factor, or 1.
    lowest: f64,
}

impl Preferences {
    pub fn load(file: &Path) -> Result<Self, String> {
        let text =
            std::fs::read_to_string(file).map_err(|e| format!("Cannot load preferences: {}: {e}", file.display()))?;
        Self::parse(&text)
    }

    fn parse(text: &str) -> Result<Self, String> {
        let mut lines = text.lines();
        if lines.next() != Some("richiroute-preferences\t1") {
            return Err("not a prepared preferences file".into());
        }
        let mut preferences = Self { factors: HashMap::default(), starts: Vec::new(), lowest: 1.0 };
        for (n, line) in lines.enumerate().filter(|(_, l)| !l.is_empty()) {
            let invalid = || format!("preferences line {}: invalid", n + 2);
            let fields: Vec<&str> = line.split('\t').collect();
            let [lon1, lat1, lon2, lat2, factor] = fields[..] else { return Err(invalid()) };
            let int = |s: &str| s.parse::<i32>().map_err(|_| invalid());
            let factor = factor.parse::<f32>().ok().filter(|f| FACTORS.contains(f)).ok_or_else(invalid)?;
            preferences.factors.insert((Pos::new(int(lon1)?, int(lat1)?), Pos::new(int(lon2)?, int(lat2)?)), factor);
            preferences.lowest = preferences.lowest.min(f64::from(factor));
        }
        let mut starts = vec![0u64; (preferences.len() * 8).next_power_of_two().div_ceil(64)];
        for &(from, _) in preferences.factors.keys() {
            let bit = start_bit(from, &starts);
            starts[bit / 64] |= 1 << (bit % 64);
        }
        preferences.starts = starts;
        Ok(preferences)
    }

    pub fn len(&self) -> usize {
        self.factors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.factors.is_empty()
    }

    /// The least a metre of road can cost: BRouter's search drops paths whose cost so far plus the distance
    /// left exceeds the best route's, as no road costs less than its length; a preferred section can.
    pub(crate) fn least_cost_per_meter(&self) -> f64 {
        self.lowest
    }

    /// The factor for travelling the section from `from` to `to`.
    pub(crate) fn factor(&self, from: Pos, to: Pos) -> f64 {
        let bit = start_bit(from, &self.starts);
        if self.starts[bit / 64] & 1 << (bit % 64) == 0 {
            return 1.0;
        }
        self.factors.get(&(from, to)).map_or(1.0, |&f| f64::from(f))
    }
}

/// The bit of `starts` for a section starting at `p`.
fn start_bit(p: Pos, starts: &[u64]) -> usize {
    let id = (u64::from(p.ilon as u32) << 32 | u64::from(p.ilat as u32)).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    (id >> 32) as usize & (starts.len() * 64 - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factors_are_per_direction() {
        let preferences =
            Preferences::parse("richiroute-preferences\t1\n1\t2\t3\t4\t0.75\n3\t4\t5\t6\t1.5\n").expect("valid");
        assert_eq!(preferences.len(), 2);
        assert_eq!(preferences.factor(Pos::new(1, 2), Pos::new(3, 4)), 0.75);
        assert_eq!(preferences.factor(Pos::new(3, 4), Pos::new(1, 2)), 1.0, "the other direction");
        assert_eq!(preferences.factor(Pos::new(3, 4), Pos::new(5, 6)), 1.5);
        assert_eq!(preferences.least_cost_per_meter(), 0.75);
        let costlier = Preferences::parse("richiroute-preferences\t1\n1\t2\t3\t4\t1.5\n").expect("valid");
        assert_eq!(costlier.least_cost_per_meter(), 1.0, "no road costs less than its length");
    }

    #[test]
    fn malformed_files_are_refused() {
        assert!(Preferences::parse("richiroute-preferences\t2\n").is_err());
        for line in ["1\t2\t3\t4", "1\t2\t3\t4\tx", "1\t2\t3\t4\t0.01", "1\t2\t3\t4\t20", "a\t2\t3\t4\t1"] {
            assert!(Preferences::parse(&format!("richiroute-preferences\t1\n{line}\n")).is_err(), "{line}");
        }
    }
}

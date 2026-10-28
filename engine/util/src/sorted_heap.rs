//! Port of `SortedHeap`, the router's open set: a set of sorted bins of growing size, merged on demand.
//! The pop order, including the order among equal keys, depends on the exact bin layout and the
//! non-empty chain, so both are kept as in Java. Bins live in a vector (index 0 is Java's `first`,
//! index 1 its `second`) and link to each other by index.

struct SortedBin<V> {
    next: Option<usize>,
    next_non_empty: Option<usize>,
    /// Keys, sorted ascending from `lp` to the end (Java's `binsize` is their length).
    al: Vec<i32>,
    vla: Vec<Option<V>>,
    /// Lowest key.
    lv: i32,
    /// Low pointer: entries are `lp..al.len()`.
    lp: usize,
}

impl<V> SortedBin<V> {
    fn new(binsize: usize) -> Self {
        Self {
            next: None,
            next_non_empty: None,
            al: vec![0; binsize],
            vla: (0..binsize).map(|_| None).collect(),
            lv: 0,
            lp: binsize,
        }
    }

    /// `add4`: the unrolled insert for bins of size 4.
    fn add4(&mut self, key: i32, value: V) {
        let mut p = self.lp;
        self.lp -= 1;
        if p == 4 || key < self.al[p] {
            self.al[p - 1] = key;
            self.lv = key;
            self.vla[p - 1] = Some(value);
            return;
        }
        self.al[p - 1] = self.al[p];
        self.lv = self.al[p - 1];
        self.vla[p - 1] = self.vla[p].take();
        p += 1;

        if p == 4 || key < self.al[p] {
            self.al[p - 1] = key;
            self.vla[p - 1] = Some(value);
            return;
        }
        self.al[p - 1] = self.al[p];
        self.vla[p - 1] = self.vla[p].take();
        p += 1;

        if p == 4 || key < self.al[p] {
            self.al[p - 1] = key;
            self.vla[p - 1] = Some(value);
            return;
        }
        self.al[p - 1] = self.al[p];
        self.vla[p - 1] = self.vla[p].take();

        self.al[p] = key;
        self.vla[p] = Some(value);
    }
}

pub struct SortedHeap<V> {
    size: i32,
    peaksize: i32,
    bins: Vec<SortedBin<V>>,
    first_non_empty: Option<usize>,
}

const FIRST: usize = 0;
const SECOND: usize = 1;

impl<V> Default for SortedHeap<V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<V> SortedHeap<V> {
    pub fn new() -> Self {
        let mut heap = Self { size: 0, peaksize: 0, bins: Vec::new(), first_non_empty: None };
        heap.clear();
        heap
    }

    /// The value with the lowest key, or `None` if empty.
    pub fn pop_lowest_key_value(&mut self) -> Option<V> {
        let first_non_empty = self.first_non_empty?;
        self.size -= 1;
        let min_bin = self.get_min_bin(first_non_empty);
        Some(self.drop_lowest(min_bin))
    }

    fn next_bin(&mut self, bin: usize) -> usize {
        if let Some(next) = self.bins[bin].next {
            return next;
        }
        let next = self.bins.len();
        self.bins.push(SortedBin::new(self.bins[bin].al.len() << 1));
        self.bins[bin].next = Some(next);
        next
    }

    fn drop_lowest(&mut self, bin: usize) -> V {
        let b = &mut self.bins[bin];
        let lp_old = b.lp;
        b.lp += 1;
        if b.lp == b.al.len() {
            self.unlink(bin);
        } else {
            b.lv = b.al[b.lp];
        }
        self.bins[bin].vla[lp_old].take().expect("sorted bin entry")
    }

    fn unlink(&mut self, bin: usize) {
        let mut ne_bin = self.first_non_empty.expect("non-empty bin chain");
        if ne_bin == bin {
            self.first_non_empty = self.bins[bin].next_non_empty;
            return;
        }
        loop {
            let next = self.bins[ne_bin].next_non_empty.expect("bin in non-empty chain");
            if next == bin {
                self.bins[ne_bin].next_non_empty = self.bins[bin].next_non_empty;
                return;
            }
            ne_bin = next;
        }
    }

    /// Java unrolls this loop to 31 steps, so it never looks beyond the 32nd non-empty bin.
    fn get_min_bin(&self, start: usize) -> usize {
        let mut min_bin = start;
        let mut bin = start;
        for _ in 0..31 {
            match self.bins[bin].next_non_empty {
                None => return min_bin,
                Some(next) => bin = next,
            }
            if self.bins[bin].lv < self.bins[min_bin].lv {
                min_bin = bin;
            }
        }
        min_bin
    }

    /// Adds a key-value pair.
    pub fn add(&mut self, key: i32, value: V) {
        self.size += 1;

        if self.bins[FIRST].lp == 0 && self.bins[SECOND].lp == 0 {
            // both full
            self.sort_up();
        }
        if self.bins[FIRST].lp > 0 {
            self.bins[FIRST].add4(key, value);
            if self.first_non_empty != Some(FIRST) {
                self.bins[FIRST].next_non_empty = self.first_non_empty;
                self.first_non_empty = Some(FIRST);
            }
        } else {
            // second bin not full
            self.bins[SECOND].add4(key, value);
            if self.bins[FIRST].next_non_empty != Some(SECOND) {
                self.bins[SECOND].next_non_empty = self.bins[FIRST].next_non_empty;
                self.bins[FIRST].next_non_empty = Some(SECOND);
            }
        }
    }

    fn sort_up(&mut self) {
        if self.size > self.peaksize {
            self.peaksize = self.size;
        }

        // determine the first array big enough to take them all
        let mut cnt = 8; // value count of first 2 bins is always 8
        let mut tbin = SECOND; // target bin
        let mut last_non_empty = SECOND;
        loop {
            tbin = self.next_bin(tbin);
            let nentries = self.bins[tbin].al.len() - self.bins[tbin].lp;
            if nentries > 0 {
                cnt += nentries;
                last_non_empty = tbin;
            }
            if cnt <= self.bins[tbin].al.len() {
                break;
            }
        }

        let mut tp = self.bins[tbin].al.len() - cnt; // target pointer

        // unlink any higher, non-empty arrays
        let other_non_empty = self.bins[last_non_empty].next_non_empty;
        self.bins[last_non_empty].next_non_empty = None;

        // now merge the content of these non-empty bins into the target bin
        while let Some(first_non_empty) = self.first_non_empty {
            let min_bin = self.get_min_bin(first_non_empty);
            let lv = self.bins[min_bin].lv;
            self.bins[tbin].al[tp] = lv;
            let value = self.drop_lowest(min_bin);
            self.bins[tbin].vla[tp] = Some(value);
            tp += 1;
        }

        let tb = &mut self.bins[tbin];
        tb.lp = tb.al.len() - cnt; // new target low pointer
        tb.lv = tb.al[tb.lp];
        tb.next_non_empty = other_non_empty;
        self.first_non_empty = Some(tbin);
    }

    pub fn clear(&mut self) {
        self.size = 0;
        self.bins = vec![SortedBin::new(4), SortedBin::new(4)];
        self.first_non_empty = None;
    }

    pub fn get_size(&self) -> i32 {
        self.size
    }

    pub fn get_peak_size(&self) -> i32 {
        self.peaksize
    }

    /// `getExtract`: a sample of about `target.len()` entries, spread over the heap. Returns their count.
    pub fn get_extract(&self, target: &mut [Option<V>]) -> usize
    where
        V: Clone,
    {
        let tsize = target.len() as i32;
        let div = (self.size / tsize + 1) as usize;
        let mut tp = 0;

        let mut lpi = 0;
        let mut bin = self.first_non_empty;
        while let Some(b) = bin {
            let b = &self.bins[b];
            lpi += b.lp;
            let n = b.al.len();
            while lpi < n {
                target[tp] = b.vla[lpi].clone();
                tp += 1;
                lpi += div;
            }
            lpi -= n;
            bin = b.next_non_empty;
        }
        tp
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pops_in_key_order() {
        let mut heap = SortedHeap::new();
        let mut state = 12_345u32;
        let mut keys = Vec::new();
        for i in 0..1000 {
            state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            let key = (state >> 16) as i32 % 100;
            keys.push(key);
            heap.add(key, i);
        }
        assert_eq!(heap.get_size(), 1000);
        let mut last = i32::MIN;
        let mut count = 0;
        while let Some(v) = heap.pop_lowest_key_value() {
            let key = keys[v];
            assert!(key >= last);
            last = key;
            count += 1;
        }
        assert_eq!(count, 1000);
        assert_eq!(heap.get_size(), 0);
    }

    #[test]
    fn interleaved_add_and_pop() {
        let mut heap = SortedHeap::new();
        heap.add(5, "a");
        heap.add(3, "b");
        assert_eq!(heap.pop_lowest_key_value(), Some("b"));
        heap.add(1, "c");
        heap.add(9, "d");
        assert_eq!(heap.pop_lowest_key_value(), Some("c"));
        assert_eq!(heap.pop_lowest_key_value(), Some("a"));
        assert_eq!(heap.pop_lowest_key_value(), Some("d"));
        assert_eq!(heap.pop_lowest_key_value(), None);
    }
}

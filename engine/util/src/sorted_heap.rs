//! Port of `SortedHeap`, the router's open set: a set of sorted bins of growing size, merged on demand.
//! The pop order, including the order among equal keys, depends on the exact bin layout and the
//! non-empty chain, so both are kept as in Java. Bins live in a vector in the order of Java's `next`
//! links (index 0 is Java's `first`, index 1 its `second`).

struct SortedBin<V> {
    /// Key-value pairs, sorted by key from `lp` to the end (Java's `binsize` is their count).
    entries: Box<[(i32, V)]>,
    /// Low pointer: the bin holds `entries[lp..]`.
    lp: usize,
}

impl<V: Copy + Default> SortedBin<V> {
    fn new(binsize: usize) -> Self {
        Self { entries: vec![(0, V::default()); binsize].into(), lp: binsize }
    }

    fn is_empty(&self) -> bool {
        self.lp == self.entries.len()
    }

    fn lowest_key(&self) -> i32 {
        self.entries[self.lp].0
    }

    /// `add4`: the unrolled insert for bins of size 4.
    fn add4(&mut self, key: i32, value: V) {
        let e = &mut self.entries;
        let mut p = self.lp;
        self.lp -= 1;
        if p == 4 || key < e[p].0 {
            e[p - 1] = (key, value);
            return;
        }
        e[p - 1] = e[p];
        p += 1;

        if p == 4 || key < e[p].0 {
            e[p - 1] = (key, value);
            return;
        }
        e[p - 1] = e[p];
        p += 1;

        if p == 4 || key < e[p].0 {
            e[p - 1] = (key, value);
            return;
        }
        e[p - 1] = e[p];
        e[p] = (key, value);
    }
}

/// More bins than an `i32` size can fill: bin 30 holds 2^31 entries.
const MAX_BINS: usize = 32;

/// The open set. Values are small handles (path indices), hence `Copy`.
pub struct SortedHeap<V> {
    size: i32,
    peaksize: i32,
    /// Each bin twice the size of the one before (except `second`). They stay allocated when the heap
    /// is cleared.
    bins: Vec<SortedBin<V>>,
    /// Java's `lv`: the lowest key of each non-empty bin.
    lows: [i32; MAX_BINS],
    /// Java's chain of non-empty bins, as a set of bin indices: every change keeps the chain in bin
    /// order (bins join it next to their neighbours), so the set gives the same iteration order.
    non_empty: u32,
    /// Buffers for `sort_up`, kept for its next call.
    merged: Vec<(i32, V)>,
    spare: Vec<(i32, V)>,
}

const FIRST: usize = 0;
const SECOND: usize = 1;

impl<V: Copy + Default> Default for SortedHeap<V> {
    fn default() -> Self {
        Self::new()
    }
}

/// The bin indices of a set, in ascending order.
fn bins_of(mut set: u32) -> impl Iterator<Item = usize> {
    std::iter::from_fn(move || {
        let bin = set.trailing_zeros() as usize;
        set &= set.wrapping_sub(1);
        (bin < MAX_BINS).then_some(bin)
    })
}

impl<V: Copy + Default> SortedHeap<V> {
    pub fn new() -> Self {
        Self {
            size: 0,
            peaksize: 0,
            bins: vec![SortedBin::new(4), SortedBin::new(4)],
            lows: [0; MAX_BINS],
            non_empty: 0,
            merged: Vec::new(),
            spare: Vec::new(),
        }
    }

    /// The value with the lowest key, or `None` if empty.
    pub fn pop_lowest_key_value(&mut self) -> Option<V> {
        if self.non_empty == 0 {
            return None;
        }
        self.size -= 1;
        let min_bin = self.get_min_bin();
        Some(self.drop_lowest(min_bin))
    }

    fn next_bin(&mut self, bin: usize) -> usize {
        let next = bin + 1;
        if next == self.bins.len() {
            assert!(next < MAX_BINS, "sorted heap overflow");
            self.bins.push(SortedBin::new(self.bins[bin].entries.len() << 1));
        }
        next
    }

    fn drop_lowest(&mut self, bin: usize) -> V {
        let b = &mut self.bins[bin];
        let (_, value) = b.entries[b.lp];
        b.lp += 1;
        if b.is_empty() {
            self.non_empty &= !(1 << bin);
        } else {
            self.lows[bin] = b.lowest_key();
        }
        value
    }

    /// The first bin in the chain with the lowest key. (Java looks at 32 bins at most, which is
    /// all there can be.)
    fn get_min_bin(&self) -> usize {
        let mut bins = bins_of(self.non_empty);
        let mut min_bin = bins.next().expect("a non-empty bin");
        for bin in bins {
            if self.lows[bin] < self.lows[min_bin] {
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
        // first bin not full, else the second (which joins the chain right after the first)
        let bin = if self.bins[FIRST].lp > 0 { FIRST } else { SECOND };
        let b = &mut self.bins[bin];
        b.add4(key, value);
        self.lows[bin] = b.lowest_key();
        self.non_empty |= 1 << bin;
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
            let b = &self.bins[tbin];
            let nentries = b.entries.len() - b.lp;
            if nentries > 0 {
                cnt += nentries;
                last_non_empty = tbin;
            }
            if cnt <= b.entries.len() {
                break;
            }
        }

        // unlink any higher, non-empty arrays
        let merging = self.non_empty & (u32::MAX >> (31 - last_non_empty));
        let other_non_empty = self.non_empty & !merging;

        // Now merge the content of these non-empty bins into the target bin. Java repeatedly moves the
        // lowest key of the first bin in the chain that has it: with sorted bins, that is a stable merge
        // of the bins in chain order.
        let (mut merged, mut spare) = (std::mem::take(&mut self.merged), std::mem::take(&mut self.spare));
        merged.clear();
        let lp = self.bins[tbin].entries.len() - cnt; // new target low pointer
        for b in bins_of(merging & !(1 << tbin)) {
            let b = &mut self.bins[b];
            spare.clear();
            merge(&merged, &b.entries[b.lp..], &mut spare);
            std::mem::swap(&mut merged, &mut spare);
            b.lp = b.entries.len();
        }
        let entries = &mut self.bins[tbin].entries;
        if merging & 1 << tbin != 0 {
            // the target bin is the last in the chain: merge in place, from the new low pointer on
            merge_into_tail(entries, lp, &merged);
        } else {
            entries[lp..].copy_from_slice(&merged);
        }

        let tb = &mut self.bins[tbin];
        tb.lp = lp;
        self.lows[tbin] = tb.lowest_key();
        self.non_empty = other_non_empty | 1 << tbin;
        (self.merged, self.spare) = (merged, spare);
    }

    /// Java replaces the bins by two new ones of size 4; emptying all keeps the same layout.
    pub fn clear(&mut self) {
        self.size = 0;
        for b in &mut self.bins {
            b.lp = b.entries.len();
        }
        self.non_empty = 0;
    }

    pub fn get_size(&self) -> i32 {
        self.size
    }

    pub fn get_peak_size(&self) -> i32 {
        self.peaksize
    }

    /// `getExtract`: a sample of about `target.len()` entries, spread over the heap. Returns their count.
    pub fn get_extract(&self, target: &mut [Option<V>]) -> usize {
        let tsize = target.len() as i32;
        let div = (self.size / tsize + 1) as usize;
        let mut tp = 0;

        let mut lpi = 0;
        for b in bins_of(self.non_empty) {
            let b = &self.bins[b];
            lpi += b.lp;
            let n = b.entries.len();
            while lpi < n {
                target[tp] = Some(b.entries[lpi].1);
                tp += 1;
                lpi += div;
            }
            lpi -= n;
        }
        tp
    }
}

/// Appends the merge of two sorted runs to `out`, taking `left`'s entry first on equal keys.
fn merge<V: Copy>(left: &[(i32, V)], right: &[(i32, V)], out: &mut Vec<(i32, V)>) {
    out.reserve(left.len() + right.len());
    let (mut i, mut j) = (0, 0);
    while i < left.len() && j < right.len() {
        // (branch-free: which run goes next is unpredictable)
        let take_right = right[j].0 < left[i].0;
        out.push(if take_right { right[j] } else { left[i] });
        j += usize::from(take_right);
        i += usize::from(!take_right);
    }
    out.extend_from_slice(&left[i..]);
    out.extend_from_slice(&right[j..]);
}

/// Merges `left` with the sorted run at the end of `entries`, writing from `entries[start]` on and
/// taking `left`'s entry first on equal keys. The run must begin at `start + left.len()`, so the
/// output never overtakes its unread part, and its rest is in place once `left` is used up.
fn merge_into_tail<V: Copy>(entries: &mut [(i32, V)], start: usize, left: &[(i32, V)]) {
    let (mut o, mut i, mut j) = (start, 0, start + left.len());
    while i < left.len() && j < entries.len() {
        let take_right = entries[j].0 < left[i].0;
        entries[o] = if take_right { entries[j] } else { left[i] };
        j += usize::from(take_right);
        i += usize::from(!take_right);
        o += 1;
    }
    entries[o..o + left.len() - i].copy_from_slice(&left[i..]);
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

    /// A bin of the reference model, with Java's fields.
    struct JavaBin {
        al: Vec<i32>,
        vla: Vec<u32>,
        lv: i32,
        lp: usize,
        next_non_empty: Option<usize>,
    }

    impl JavaBin {
        fn new(binsize: usize) -> Self {
            Self { al: vec![0; binsize], vla: vec![0; binsize], lv: 0, lp: binsize, next_non_empty: None }
        }
    }

    /// Java's merge, entry by entry: the reference for the bin layout and the order of equal keys.
    struct JavaHeap {
        size: i32,
        bins: Vec<JavaBin>,
        first_non_empty: Option<usize>,
    }

    impl JavaHeap {
        fn new() -> Self {
            Self { size: 0, bins: vec![JavaBin::new(4), JavaBin::new(4)], first_non_empty: None }
        }

        fn min_bin(&self) -> usize {
            let mut min = self.first_non_empty.unwrap();
            let mut bin = self.bins[min].next_non_empty;
            while let Some(b) = bin {
                if self.bins[b].lv < self.bins[min].lv {
                    min = b;
                }
                bin = self.bins[b].next_non_empty;
            }
            min
        }

        fn drop_lowest(&mut self, bin: usize) -> u32 {
            let b = &mut self.bins[bin];
            let value = b.vla[b.lp];
            b.lp += 1;
            if b.lp == b.al.len() {
                let next = b.next_non_empty;
                if self.first_non_empty == Some(bin) {
                    self.first_non_empty = next;
                } else {
                    let mut ne = self.first_non_empty.unwrap();
                    while self.bins[ne].next_non_empty != Some(bin) {
                        ne = self.bins[ne].next_non_empty.unwrap();
                    }
                    self.bins[ne].next_non_empty = next;
                }
            } else {
                b.lv = b.al[b.lp];
            }
            value
        }

        fn pop(&mut self) -> Option<u32> {
            self.first_non_empty?;
            self.size -= 1;
            let bin = self.min_bin();
            Some(self.drop_lowest(bin))
        }

        fn add4(&mut self, bin: usize, key: i32, value: u32) {
            let b = &mut self.bins[bin];
            b.lp -= 1;
            let mut p = b.lp;
            while p + 1 < 4 && b.al[p + 1] <= key {
                b.al[p] = b.al[p + 1];
                b.vla[p] = b.vla[p + 1];
                p += 1;
            }
            b.al[p] = key;
            b.vla[p] = value;
            b.lv = b.al[b.lp];
        }

        fn add(&mut self, key: i32, value: u32) {
            self.size += 1;
            if self.bins[0].lp == 0 && self.bins[1].lp == 0 {
                self.sort_up();
            }
            if self.bins[0].lp > 0 {
                self.add4(0, key, value);
                if self.first_non_empty != Some(0) {
                    self.bins[0].next_non_empty = self.first_non_empty;
                    self.first_non_empty = Some(0);
                }
            } else {
                self.add4(1, key, value);
                if self.bins[0].next_non_empty != Some(1) {
                    self.bins[1].next_non_empty = self.bins[0].next_non_empty;
                    self.bins[0].next_non_empty = Some(1);
                }
            }
        }

        fn sort_up(&mut self) {
            let (mut cnt, mut tbin, mut last_non_empty) = (8, 1, 1);
            loop {
                tbin += 1;
                if tbin == self.bins.len() {
                    self.bins.push(JavaBin::new(self.bins[tbin - 1].al.len() * 2));
                }
                let b = &self.bins[tbin];
                if b.lp < b.al.len() {
                    cnt += b.al.len() - b.lp;
                    last_non_empty = tbin;
                }
                if cnt <= b.al.len() {
                    break;
                }
            }
            let other_non_empty = self.bins[last_non_empty].next_non_empty.take();
            let mut tp = self.bins[tbin].al.len() - cnt;
            while self.first_non_empty.is_some() {
                let min = self.min_bin();
                let key = self.bins[min].lv;
                let value = self.drop_lowest(min);
                self.bins[tbin].al[tp] = key;
                self.bins[tbin].vla[tp] = value;
                tp += 1;
            }
            let tb = &mut self.bins[tbin];
            tb.lp = tb.al.len() - cnt;
            tb.lv = tb.al[tb.lp];
            tb.next_non_empty = other_non_empty;
            self.first_non_empty = Some(tbin);
        }
    }

    #[test]
    fn same_order_as_javas_merge() {
        let mut state = 4711u32;
        let mut next = |n: u32| {
            state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            (state >> 8) % n
        };
        let mut heap = SortedHeap::new();
        for round in 0..40 {
            // adds from half to two thirds of the time, keys with many ties
            let (adds, keys) = (500 + 10 * (round % 17), [3, 50, 1000, 1 << 20][round as usize % 4]);
            let mut java = JavaHeap::new();
            heap.clear();
            for value in 0..20_000 {
                if next(1000) < adds {
                    let key = next(keys) as i32 - 7;
                    heap.add(key, value);
                    java.add(key, value);
                } else {
                    assert_eq!(heap.pop_lowest_key_value(), java.pop());
                }
                assert_eq!(heap.get_size(), java.size);
            }
            while let Some(v) = java.pop() {
                assert_eq!(heap.pop_lowest_key_value(), Some(v));
            }
            assert_eq!(heap.pop_lowest_key_value(), None);
        }
    }
}

//! The id->node index of `OsmNodesMap`, laid out like Java's `HashMap<OsmNode, OsmNode>(4096)`.
//!
//! `collectOutreachers` walks this map's values, and the walk order changes `nodesCreated` (a node
//! whose links all vanished before the walk reaches it is counted out), which feeds the memory checks.
//! So the bucket structure follows `java.util.HashMap`: `hashCode() = ilon + ilat`, spread by
//! `h ^ (h >>> 16)`, power-of-two tables starting at 4096, load factor 0.75, new entries appended to
//! their bucket, and resizes that split each bucket into a low and a high list in order.
//!
//! Java turns a bucket into a red-black tree once it holds more than 8 entries; the tree changes the
//! iteration order within that bucket, and for keys with equal hashes it orders by identity hash code,
//! which is not reproducible even between Java runs. This map keeps buckets as lists and counts such
//! buckets in `treeified_buckets` so callers can tell when the order may differ.

use crate::NodeIdx;

const NIL: u32 = u32::MAX;
const INITIAL_CAPACITY: usize = 4096;
const TREEIFY_THRESHOLD: usize = 8;

struct Entry {
    hash: i32,
    ilon: i32,
    ilat: i32,
    node: NodeIdx,
    next: u32,
}

pub(crate) struct NodeHashMap {
    table: Vec<u32>,
    entries: Vec<Entry>,
    free: Vec<u32>,
    size: usize,
    threshold: usize,
    /// Insertions into buckets that already held `TREEIFY_THRESHOLD` entries.
    pub(crate) treeified_buckets: usize,
}

fn spread(ilon: i32, ilat: i32) -> i32 {
    let h = ilon.wrapping_add(ilat);
    h ^ ((h as u32) >> 16) as i32
}

impl NodeHashMap {
    /// Java allocates the table on the first put; allocating it here gives the same layout.
    pub(crate) fn new() -> Self {
        let mut map = Self {
            table: Vec::new(),
            entries: Vec::new(),
            free: Vec::new(),
            size: 0,
            threshold: 0,
            treeified_buckets: 0,
        };
        map.clear();
        map
    }

    /// Empties the map, back to the initial capacity (which the iteration order depends on).
    pub(crate) fn clear(&mut self) {
        if self.table.len() == INITIAL_CAPACITY {
            self.table.fill(NIL);
        } else {
            self.table = vec![NIL; INITIAL_CAPACITY]; // resizing allocates a new table anyway
        }
        self.entries.clear();
        self.free.clear();
        self.size = 0;
        self.threshold = INITIAL_CAPACITY * 3 / 4;
        self.treeified_buckets = 0;
    }

    fn bucket(&self, hash: i32) -> usize {
        hash as u32 as usize & (self.table.len() - 1)
    }

    pub(crate) fn get(&self, ilon: i32, ilat: i32) -> Option<NodeIdx> {
        let hash = spread(ilon, ilat);
        let mut e = self.table[self.bucket(hash)];
        while e != NIL {
            let entry = &self.entries[e as usize];
            if entry.hash == hash && entry.ilon == ilon && entry.ilat == ilat {
                return Some(entry.node);
            }
            e = entry.next;
        }
        None
    }

    /// Maps the position to `node`. Returns the previous node; an existing entry keeps its place.
    pub(crate) fn put(&mut self, ilon: i32, ilat: i32, node: NodeIdx) -> Option<NodeIdx> {
        let hash = spread(ilon, ilat);
        let bucket = self.bucket(hash);
        let mut e = self.table[bucket];
        let mut tail = NIL;
        let mut bin_count = 0;
        while e != NIL {
            let entry = &mut self.entries[e as usize];
            if entry.hash == hash && entry.ilon == ilon && entry.ilat == ilat {
                return Some(std::mem::replace(&mut entry.node, node));
            }
            tail = e;
            e = entry.next;
            bin_count += 1;
        }
        let entry = Entry { hash, ilon, ilat, node, next: NIL };
        let new = match self.free.pop() {
            Some(slot) => {
                self.entries[slot as usize] = entry;
                slot
            }
            None => {
                self.entries.push(entry);
                (self.entries.len() - 1) as u32
            }
        };
        if tail == NIL {
            self.table[bucket] = new;
        } else {
            self.entries[tail as usize].next = new;
        }
        if bin_count >= TREEIFY_THRESHOLD {
            self.treeified_buckets += 1;
        }
        self.size += 1;
        if self.size > self.threshold {
            self.resize();
        }
        None
    }

    pub(crate) fn remove(&mut self, ilon: i32, ilat: i32) -> Option<NodeIdx> {
        let hash = spread(ilon, ilat);
        let bucket = self.bucket(hash);
        let mut e = self.table[bucket];
        let mut prev = NIL;
        while e != NIL {
            let entry = &self.entries[e as usize];
            let next = entry.next;
            if entry.hash == hash && entry.ilon == ilon && entry.ilat == ilat {
                let node = entry.node;
                if prev == NIL {
                    self.table[bucket] = next;
                } else {
                    self.entries[prev as usize].next = next;
                }
                self.free.push(e);
                self.size -= 1;
                return Some(node);
            }
            prev = e;
            e = next;
        }
        None
    }

    fn resize(&mut self) {
        let old_cap = self.table.len();
        let new_cap = old_cap << 1;
        self.threshold <<= 1;
        let mut new_table = vec![NIL; new_cap];
        for (j, &head) in self.table.iter().enumerate() {
            let (mut lo_head, mut lo_tail, mut hi_head, mut hi_tail) = (NIL, NIL, NIL, NIL);
            let mut e = head;
            while e != NIL {
                let next = self.entries[e as usize].next;
                let (head, tail) = if self.entries[e as usize].hash as u32 as usize & old_cap == 0 {
                    (&mut lo_head, &mut lo_tail)
                } else {
                    (&mut hi_head, &mut hi_tail)
                };
                if *tail == NIL {
                    *head = e;
                } else {
                    self.entries[*tail as usize].next = e;
                }
                *tail = e;
                e = next;
            }
            if lo_tail != NIL {
                self.entries[lo_tail as usize].next = NIL;
                new_table[j] = lo_head;
            }
            if hi_tail != NIL {
                self.entries[hi_tail as usize].next = NIL;
                new_table[j + old_cap] = hi_head;
            }
        }
        self.table = new_table;
    }

    /// The nodes in Java's iteration order.
    pub(crate) fn values(&self) -> impl Iterator<Item = NodeIdx> + '_ {
        self.table.iter().flat_map(move |&head| {
            std::iter::successors((head != NIL).then_some(head), move |&e| {
                let next = self.entries[e as usize].next;
                (next != NIL).then_some(next)
            })
            .map(move |e| self.entries[e as usize].node)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idx(i: usize) -> NodeIdx {
        NodeIdx::from_index(i)
    }

    #[test]
    fn put_get_remove_and_order() {
        let mut map = NodeHashMap::new();
        // Equal hashes (ilon + ilat) share a bucket and keep insertion order.
        assert_eq!(map.put(10, 20, idx(0)), None);
        assert_eq!(map.put(20, 10, idx(1)), None);
        assert_eq!(map.put(5, 0, idx(2)), None);
        assert_eq!(map.put(10, 20, idx(3)), Some(idx(0)));
        assert_eq!(map.get(20, 10), Some(idx(1)));
        let order: Vec<_> = map.values().collect();
        assert_eq!(order, vec![idx(2), idx(3), idx(1)]);
        assert_eq!(map.remove(10, 20), Some(idx(3)));
        assert_eq!(map.get(10, 20), None);
        assert_eq!(map.size, 2);
    }

    #[test]
    fn resize_keeps_relative_order() {
        let mut map = NodeHashMap::new();
        for i in 0..10_000 {
            map.put(i * 7919, i * 104_729, idx(i as usize));
        }
        assert_eq!(map.size, 10_000);
        assert_eq!(map.table.len(), 16_384);
        for i in (0..10_000).step_by(37) {
            assert_eq!(map.get(i * 7919, i * 104_729), Some(idx(i as usize)));
        }
        // Java's order: by bucket index, then insertion order within a bucket.
        let mut expected: Vec<(usize, usize)> =
            (0..10_000).map(|i| (spread(i * 7919, i * 104_729) as u32 as usize & 16_383, i as usize)).collect();
        expected.sort();
        let order: Vec<_> = map.values().collect();
        assert_eq!(order, expected.iter().map(|&(_, i)| idx(i)).collect::<Vec<_>>());
    }
}

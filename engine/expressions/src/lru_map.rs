//! Port of `btools.util.LruMap`: a hash map with fixed bins and an LRU queue. Java links the
//! `LruMapNode` objects directly; here the nodes live in an arena and link by index. `insert` reuses
//! the evicted node's slot, as Java reuses the node object.

use std::num::NonZeroU32;

/// A node index plus one, so `Option<Link>` stays 4 bytes.
type Link = NonZeroU32;

fn link(idx: u32) -> Link {
    Link::new(idx + 1).expect("index below u32::MAX")
}

pub(crate) struct LruMap<T> {
    hashbins: i32,
    maxsize: i32,
    size: i32,
    lru: Option<Link>,
    mru: Option<Link>,
    bins: Vec<Option<Link>>,
    nodes: Vec<Node<T>>,
}

struct Node<T> {
    next_in_bin: Option<Link>,
    /// Towards the MRU end.
    next: Option<Link>,
    /// Towards the LRU end.
    previous: Option<Link>,
    hash: i32,
    value: T,
}

impl<T> LruMap<T> {
    pub(crate) fn new(bins: i32, size: i32) -> Self {
        Self {
            hashbins: bins,
            maxsize: size,
            size: 0,
            lru: None,
            mru: None,
            bins: vec![None; bins as usize],
            nodes: Vec::new(),
        }
    }

    fn bin(&self, hash: i32) -> usize {
        ((hash & 0x0fff_ffff) % self.hashbins) as usize
    }

    fn node(&self, l: Link) -> &Node<T> {
        &self.nodes[l.get() as usize - 1]
    }

    fn node_mut(&mut self, l: Link) -> &mut Node<T> {
        &mut self.nodes[l.get() as usize - 1]
    }

    pub(crate) fn value(&self, idx: u32) -> &T {
        &self.node(link(idx)).value
    }

    /// The first node in the hash's bin that has the same hash and satisfies `matches` (Java's
    /// `key.equals(e)` of the cache node types).
    pub(crate) fn get(&self, hash: i32, matches: impl Fn(&T) -> bool) -> Option<u32> {
        let mut e = self.bins[self.bin(hash)];
        while let Some(l) = e {
            let node = self.node(l);
            if node.hash == hash && matches(&node.value) {
                return Some(l.get() - 1);
            }
            e = node.next_in_bin;
        }
        None
    }

    /// Moves a node to the MRU end of the queue.
    pub(crate) fn touch(&mut self, idx: u32) {
        let e = link(idx);
        let (Some(n), p) = (self.node(e).next, self.node(e).previous) else {
            return; // already at mru
        };
        self.node_mut(n).previous = p;
        match p {
            Some(p) => self.node_mut(p).next = Some(n),
            None => self.lru = Some(n),
        }
        let mru = self.mru.expect("a queue with a successor has an mru");
        self.node_mut(mru).next = Some(e);
        let node = self.node_mut(e);
        node.previous = Some(mru);
        node.next = None;
        self.mru = Some(e);
    }

    /// Java's `removeLru()`, a new node if that gives none, then `put`: once the map is full, the
    /// least recently used node's slot takes the new entry.
    pub(crate) fn insert(&mut self, hash: i32, value: T) -> u32 {
        let e = match self.remove_lru() {
            Some(e) => {
                let node = self.node_mut(e);
                node.hash = hash;
                node.value = value;
                e
            }
            None => {
                self.nodes.push(Node { next_in_bin: None, next: None, previous: None, hash, value });
                link(self.nodes.len() as u32 - 1)
            }
        };
        self.put(e);
        e.get() - 1
    }

    /// Unlinks the LRU node once the map is full.
    fn remove_lru(&mut self) -> Option<Link> {
        if self.size < self.maxsize {
            return None;
        }
        self.size -= 1;
        let lru = self.lru.expect("a full map has an lru");
        // unlink the lru from its bin queue
        let bin = self.bin(self.node(lru).hash);
        let next_in_bin = self.node(lru).next_in_bin;
        if self.bins[bin] == Some(lru) {
            self.bins[bin] = next_in_bin;
        } else {
            let mut e = self.bins[bin];
            while let Some(prev) = e {
                e = self.node(prev).next_in_bin;
                if e == Some(lru) {
                    self.node_mut(prev).next_in_bin = next_in_bin;
                    break;
                }
            }
        }
        self.lru = self.node(lru).next;
        match self.lru {
            Some(new_lru) => self.node_mut(new_lru).previous = None,
            // Java throws here (a map of size 1); keep the queue consistent instead.
            None => self.mru = None,
        }
        Some(lru)
    }

    fn put(&mut self, e: Link) {
        let bin = self.bin(self.node(e).hash);
        let (head, mru) = (self.bins[bin], self.mru);
        let node = self.node_mut(e);
        node.next_in_bin = head;
        node.previous = mru;
        node.next = None;
        self.bins[bin] = Some(e);
        match mru {
            Some(mru) => self.node_mut(mru).next = Some(e),
            None => self.lru = Some(e),
        }
        self.mru = Some(e);
        self.size += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_least_recently_used() {
        let mut map = LruMap::new(4, 3);
        for v in 0..3 {
            map.insert(v, v);
        }
        let one = map.get(1, |v| *v == 1).unwrap();
        map.touch(map.get(0, |v| *v == 0).unwrap());
        assert_eq!(map.insert(7, 7), one); // evicts 1, the least recently used, and reuses its slot
        assert!(map.get(1, |v| *v == 1).is_none());
        assert!(map.get(0, |v| *v == 0).is_some() && map.get(2, |v| *v == 2).is_some());
        map.insert(11, 11); // evicts 2: 0 was touched after it
        assert!(map.get(2, |v| *v == 2).is_none());
    }

    #[test]
    fn same_bin_chains_newest_first() {
        let mut map = LruMap::new(2, 8);
        map.insert(3, 30); // bin 1
        map.insert(5, 50); // bin 1, chained before 3
        map.insert(3, 31); // same hash: the newest wins a hash-only match
        assert_eq!(*map.value(map.get(3, |_| true).unwrap()), 31);
        assert_eq!(*map.value(map.get(3, |v| *v == 30).unwrap()), 30);
    }
}

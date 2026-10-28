//! `CompactLongMap` on top of `BTreeMap`. Java's version is a memory-optimised sorted array with the same
//! observable behaviour: lookups by `long` key. Nothing in BRouter depends on its internal layout.

use std::collections::BTreeMap;

/// Port of `CompactLongMap`: a growing map from `i64` keys to values.
#[derive(Clone)]
pub struct CompactLongMap<V> {
    map: BTreeMap<i64, V>,
}

impl<V> Default for CompactLongMap<V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<V> CompactLongMap<V> {
    pub fn new() -> Self {
        Self { map: BTreeMap::new() }
    }

    /// Puts `value`, replacing an existing one. Returns true if the key existed.
    pub fn put(&mut self, id: i64, value: V) -> bool {
        self.map.insert(id, value).is_some()
    }

    /// `fastPut`: callers guarantee the key is new. Java detects a duplicate only later, when it
    /// restructures; this panics right away with the same message.
    pub fn fast_put(&mut self, id: i64, value: V) {
        if self.map.insert(id, value).is_some() {
            panic!("duplicate key found in late check: {id}");
        }
    }

    pub fn get(&self, id: i64) -> Option<&V> {
        self.map.get(&id)
    }

    pub fn get_mut(&mut self, id: i64) -> Option<&mut V> {
        self.map.get_mut(&id)
    }

    pub fn contains(&self, id: i64) -> bool {
        self.map.contains_key(&id)
    }

    pub fn size(&self) -> usize {
        self.map.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_get() {
        let mut map = CompactLongMap::new();
        map.fast_put(5, "five");
        map.fast_put(-3, "minus three");
        assert!(map.put(5, "FIVE"));
        assert!(!map.put(1, "one"));
        assert_eq!(map.get(5), Some(&"FIVE"));
        assert!(!map.contains(2));
        assert_eq!(map.size(), 3);
    }
}

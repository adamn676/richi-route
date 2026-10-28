//! `CompactLongMap` and `FrozenLongMap` on top of `BTreeMap`. Java's versions are memory-optimised sorted
//! arrays with the same observable behaviour: lookups by `long` key, and frozen maps that list their
//! entries in ascending key order. Nothing in BRouter depends on their internal layout.

use std::collections::BTreeMap;

/// Port of `CompactLongMap`: a growing map from `i64` keys to values.
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

    /// `new FrozenLongMap(map)`.
    pub fn freeze(self) -> FrozenLongMap<V> {
        let (keys, values) = self.map.into_iter().unzip();
        FrozenLongMap { keys, values }
    }
}

/// Port of `FrozenLongMap`: a map with a fixed, sorted key set.
pub struct FrozenLongMap<V> {
    keys: Vec<i64>,
    values: Vec<V>,
}

impl<V> FrozenLongMap<V> {
    /// Replaces the value of an existing key; a new key is an error, as in Java.
    pub fn put(&mut self, id: i64, value: V) -> bool {
        match self.keys.binary_search(&id) {
            Ok(i) => {
                self.values[i] = value;
                true
            }
            Err(_) => panic!("cannot only put on existing key in FrozenLongIntMap"),
        }
    }

    pub fn get(&self, id: i64) -> Option<&V> {
        self.keys.binary_search(&id).ok().map(|i| &self.values[i])
    }

    pub fn get_mut(&mut self, id: i64) -> Option<&mut V> {
        self.keys.binary_search(&id).ok().map(|i| &mut self.values[i])
    }

    pub fn contains(&self, id: i64) -> bool {
        self.keys.binary_search(&id).is_ok()
    }

    pub fn size(&self) -> usize {
        self.keys.len()
    }

    /// The values in ascending key order (`getValueList`).
    pub fn value_list(&self) -> &[V] {
        &self.values
    }

    /// The keys in ascending order (`getKeyArray`).
    pub fn key_array(&self) -> &[i64] {
        &self.keys
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_get_freeze() {
        let mut map = CompactLongMap::new();
        map.fast_put(5, "five");
        map.fast_put(-3, "minus three");
        assert!(map.put(5, "FIVE"));
        assert!(!map.put(1, "one"));
        assert_eq!(map.get(5), Some(&"FIVE"));
        assert!(!map.contains(2));
        let mut frozen = map.freeze();
        assert_eq!(frozen.key_array(), &[-3, 1, 5]);
        assert_eq!(frozen.value_list(), &["minus three", "one", "FIVE"]);
        frozen.put(1, "ONE");
        assert_eq!(frozen.get(1), Some(&"ONE"));
        assert_eq!(frozen.get(2), None);
    }
}

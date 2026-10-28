//! The segment files and decoded cells that all searches of a process share.
//!
//! Java opens the segment files and decodes every cell again for each `NodesCache`, i.e. for every
//! search. What it reads from the files does not depend on the request: a decoded cell
//! (`DecodedCell`) holds everything the decoder reads from the bit stream before any profile is
//! involved. Weaving it into a search's graph replays the validator and matcher calls Java makes
//! while decoding, in the same order, so the profile's caches and the graph end up exactly as if the
//! cell had been decoded from the file.

use crate::direct_weaver::DecodedCell;
use crate::files::{FileStamp, IoResult, PhysicalFile};
use std::collections::HashMap;
use std::hash::Hash;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// A cell of an open segment file, as asked for: the cell index within the degree square follows
/// from the position, and so does the corner the decoder puts the nodes at. (Near lon -180 and lat
/// -90, truncating division makes positions of one cell index decode with different corners.)
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) struct CellKey {
    /// `PhysicalFile::id`.
    pub(crate) file: u64,
    pub(crate) tile: u32,
    pub(crate) lon_idx: i32,
    pub(crate) lat_idx: i32,
}

/// The segment directory with its open files and a bounded cache of decoded cells, shared by all
/// searches and threads (wrap it in an `Arc`).
///
/// Each search still checks the files as Java does when it first touches them: a missing file is
/// missing for that search (and the next search looks again), a replaced file (different size or
/// modification time) is opened again, and the lookup table version is checked against the
/// search's profile. Open files stay open until replaced or the store is dropped.
///
/// Decoded cells are kept up to a budget in bytes, least recently used first out. A budget of 0
/// disables the cache: every search decodes its cells from the files, as Java does.
pub struct SegmentStore {
    dir: PathBuf,
    /// The open files by name, at most `MAX_OPEN_FILES`, each counted as 1.
    files: Mutex<Lru<FileName, Arc<PhysicalFile>>>,
    cells: Mutex<Lru<CellKey, Arc<DecodedCell>>>,
    next_file_id: AtomicU64,
}

/// How many segment files stay open (Java closes them after each request). A search needs a few.
const MAX_OPEN_FILES: usize = 32;

/// A segment file name, `E10_N45.rd5`, as a copyable key.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
struct FileName([u8; 16]);

impl FileName {
    fn new(name: &str) -> Option<Self> {
        let mut bytes = [0; 16];
        bytes.get_mut(..name.len())?.copy_from_slice(name.as_bytes());
        Some(Self(bytes))
    }
}

/// Recovers the data after a panic in another thread: every critical section leaves it consistent.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl SegmentStore {
    /// The default budget for decoded cells. The planner's loop suggestions (36 round trips from one
    /// start) need 30 to 60 MB of cells; half of that already gives most of the speed.
    pub const DEFAULT_CELL_CACHE_BYTES: usize = 64 << 20;

    pub fn new(segment_dir: impl Into<PathBuf>, cell_cache_bytes: usize) -> Self {
        Self {
            dir: segment_dir.into(),
            files: Mutex::new(Lru::new(MAX_OPEN_FILES)),
            cells: Mutex::new(Lru::new(cell_cache_bytes)),
            next_file_id: AtomicU64::new(0),
        }
    }

    pub fn segment_dir(&self) -> &Path {
        &self.dir
    }

    /// `PhysicalFile` for `<dir>/<file_name>`, `None` if the file does not exist (Java: `exists()`
    /// and `new PhysicalFile(...)`); errors are not kept, so the next search tries again.
    pub(crate) fn open_file(&self, file_name: &str, lookup_version: i32) -> IoResult<Option<Arc<PhysicalFile>>> {
        let path = self.dir.join(file_name);
        let Ok(meta) = std::fs::metadata(&path) else {
            return Ok(None);
        };
        let key = FileName::new(file_name).expect("segment file names are short");
        let mut files = lock(&self.files);
        if let Some(file) = files.get(&key).filter(|f| f.stamp == FileStamp::of(&meta)) {
            file.check_lookup_version(lookup_version)?;
            return Ok(Some(file.clone()));
        }
        // cells of a replaced or closed file are never asked for again and age out of the cache
        files.remove(&key);
        let id = self.next_file_id.fetch_add(1, Ordering::Relaxed);
        let file = Arc::new(PhysicalFile::open(&path, lookup_version, id)?);
        files.insert(key, file.clone(), 1);
        Ok(Some(file))
    }

    /// The decoded cell, from the cache or decoded now. Threads that miss the same cell at once both
    /// decode it; the results are equal.
    pub(crate) fn cell(
        &self,
        key: CellKey,
        decode: impl FnOnce() -> IoResult<DecodedCell>,
    ) -> IoResult<Arc<DecodedCell>> {
        if let Some(cell) = lock(&self.cells).get(&key) {
            return Ok(cell.clone());
        }
        let cell = Arc::new(decode()?);
        let bytes = cell.heap_bytes();
        lock(&self.cells).insert(key, cell.clone(), bytes);
        Ok(cell)
    }

    /// Accounts for a cached cell that grew by `bytes` (or shrank).
    pub(crate) fn charge(&self, key: CellKey, cell: &Arc<DecodedCell>, bytes: isize) {
        if bytes != 0 {
            lock(&self.cells).charge(key, |cached| Arc::ptr_eq(cached, cell), bytes);
        }
    }
}

/// A map that keeps its values up to a total size, dropping the least recently used. A hit only
/// stamps the entry; going over the size sorts the entries by age and drops a batch, down to 15/16.
struct Lru<K, V> {
    budget: usize,
    bytes: usize,
    /// Last use, value and size.
    entries: HashMap<K, (u64, V, usize)>,
    clock: u64,
}

impl<K: Copy + Eq + Hash, V> Lru<K, V> {
    fn new(budget: usize) -> Self {
        Self { budget, bytes: 0, entries: HashMap::new(), clock: 0 }
    }

    fn get(&mut self, key: &K) -> Option<&V> {
        self.clock += 1;
        let (last_use, value, _) = self.entries.get_mut(key)?;
        *last_use = self.clock;
        Some(value)
    }

    /// Inserts the value unless the key is present or the value alone exceeds the budget.
    fn insert(&mut self, key: K, value: V, bytes: usize) {
        if bytes > self.budget || self.entries.contains_key(&key) {
            return;
        }
        self.bytes += bytes;
        self.evict_to_budget();
        self.clock += 1;
        self.entries.insert(key, (self.clock, value, bytes));
    }

    fn remove(&mut self, key: &K) {
        if let Some((_, _, size)) = self.entries.remove(key) {
            self.bytes -= size;
        }
    }

    /// Changes the size of the key's entry if `is_entry` accepts its value.
    fn charge(&mut self, key: K, is_entry: impl FnOnce(&V) -> bool, bytes: isize) {
        let Some((_, value, size)) = self.entries.get_mut(&key) else { return };
        if is_entry(value) {
            let new_size = size.checked_add_signed(bytes).expect("charges within the entry's size");
            self.bytes = self.bytes - *size + new_size;
            *size = new_size;
            self.evict_to_budget();
        }
    }

    fn evict_to_budget(&mut self) {
        if self.bytes <= self.budget {
            return;
        }
        let target = self.budget - self.budget / 16;
        let mut by_age: Vec<(u64, K)> = self.entries.iter().map(|(&key, &(last_use, _, _))| (last_use, key)).collect();
        by_age.sort_unstable_by_key(|&(last_use, _)| last_use);
        for (_, key) in by_age {
            if self.bytes <= target {
                break;
            }
            self.remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_keeps_the_budget_and_drops_the_least_recently_used() {
        let mut lru = Lru::new(10);
        let get = |lru: &mut Lru<i32, &'static str>, key| lru.get(&key).copied();
        lru.insert(1, "a", 4);
        lru.insert(2, "b", 4);
        assert_eq!(get(&mut lru, 1), Some("a")); // 2 is now the oldest
        lru.insert(3, "c", 4);
        assert_eq!([get(&mut lru, 2), get(&mut lru, 1), get(&mut lru, 3)], [None, Some("a"), Some("c")]);
        assert_eq!(lru.bytes, 8);
        lru.insert(3, "c2", 1); // present: kept as is
        assert_eq!(get(&mut lru, 3), Some("c"));
        lru.insert(4, "too big", 11);
        assert_eq!(get(&mut lru, 4), None);
        assert_eq!(lru.bytes, 8);
        lru.insert(5, "e", 10); // evicts everything else
        assert_eq!([get(&mut lru, 1), get(&mut lru, 3), get(&mut lru, 5)], [None, None, Some("e")]);
        assert_eq!(lru.bytes, 10);
    }

    #[test]
    fn charges_change_sizes_and_evict() {
        let mut lru = Lru::new(10);
        lru.insert(1, "a", 4);
        lru.insert(2, "b", 4);
        lru.charge(2, |v| *v == "other", 5); // not that value: ignored
        assert_eq!(lru.bytes, 8);
        lru.charge(2, |v| *v == "b", 5); // 2 grows to 9, 1 is the oldest and goes
        assert_eq!((lru.bytes, lru.entries.contains_key(&1)), (9, false));
        lru.charge(2, |_| true, -6);
        assert_eq!(lru.bytes, 3);
        lru.insert(3, "c", 7);
        assert_eq!((lru.bytes, lru.entries.len()), (10, 2));
    }

    #[test]
    fn zero_budget_keeps_nothing() {
        let mut lru = Lru::new(0);
        lru.insert(1, (), 1);
        assert!(lru.get(&1).is_none());
        assert!(lru.entries.is_empty());
    }
}

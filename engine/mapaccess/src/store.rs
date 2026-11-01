//! The segment files and decoded cells that all searches of a process share.
//!
//! Java opens the segment files and decodes every cell again for each `NodesCache`, i.e. for every
//! search. What it reads from the files does not depend on the request: a decoded cell
//! (`DecodedCell`) holds everything the decoder reads from the bit stream before any profile is
//! involved. Weaving it into a search's graph replays the validator and matcher calls Java makes
//! while decoding, in the same order, so the profile's caches and the graph end up exactly as if the
//! cell had been decoded from the file.
//!
//! The same makes decoding ahead safe: a thread of the store decodes the cells next to each cell a search
//! weaves (`SegmentStore::prefetch`), so a long search finds most of its cells decoded, and only its
//! speed depends on whether it did.

use crate::direct_weaver::DecodedCell;
use crate::files::{FileStamp, IoResult, PhysicalFile, read_cell};
use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};

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
    prefetcher: Arc<Prefetcher>,
}

/// A cell to decode ahead of a search, on the prefetcher's thread: the cells around each cell a search
/// weaves are likely next. The search then finds them in the store instead of decoding them itself.
pub(crate) struct Prefetch {
    pub(crate) key: CellKey,
    pub(crate) file: Arc<PhysicalFile>,
    pub(crate) pos: u64,
    pub(crate) len: usize,
    pub(crate) divisor: i32,
    /// Per lookup index: does the search's profile use it? (`DecodedCell::decode`)
    pub(crate) lookups_used: Arc<[bool]>,
}

/// The cells waiting to be decoded ahead, newest last, and the thread that decodes them. Off with a
/// single processor, where it would only slow the search down, without a cell cache, and when the
/// thread cannot start.
struct Prefetcher {
    on: AtomicBool,
    jobs: Mutex<PrefetchJobs>,
    wake: Condvar,
}

#[derive(Default)]
struct PrefetchJobs {
    queue: VecDeque<Prefetch>,
    started: bool,
    closed: bool,
}

/// Older requests than this are dropped: the search has moved on.
const MAX_PREFETCHES: usize = 64;

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
            prefetcher: Arc::new(Prefetcher {
                on: AtomicBool::new(
                    cell_cache_bytes > 0 && std::thread::available_parallelism().is_ok_and(|n| n.get() > 1),
                ),
                jobs: Mutex::default(),
                wake: Condvar::new(),
            }),
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

    /// Queues these cells for decoding ahead, unless cached or queued already.
    pub(crate) fn prefetch(self: &Arc<Self>, cells: impl Iterator<Item = Prefetch>) {
        if !self.prefetcher.on.load(Ordering::Relaxed) {
            return;
        }
        let mut jobs = lock(&self.prefetcher.jobs);
        let cached = lock(&self.cells);
        let mut added = false;
        for cell in cells {
            if cached.entries.contains_key(&cell.key) || jobs.queue.iter().any(|job| job.key == cell.key) {
                continue;
            }
            if jobs.queue.len() == MAX_PREFETCHES {
                jobs.queue.pop_front();
            }
            jobs.queue.push_back(cell);
            added = true;
        }
        drop(cached);
        if !added {
            return;
        }
        if !jobs.started {
            jobs.started = true;
            let (store, prefetcher) = (Arc::downgrade(self), self.prefetcher.clone());
            // without the thread, the searches decode their cells themselves
            let spawned = std::thread::Builder::new()
                .name("cell prefetch".into())
                .spawn(move || prefetch_cells(&store, &prefetcher));
            if spawned.is_err() {
                self.prefetcher.on.store(false, Ordering::Relaxed);
                jobs.queue.clear();
                return;
            }
        }
        self.prefetcher.wake.notify_one();
    }

    /// Accounts for a cached cell that grew by `bytes` (or shrank).
    pub(crate) fn charge(&self, key: CellKey, cell: &Arc<DecodedCell>, bytes: isize) {
        if bytes != 0 {
            lock(&self.cells).charge(key, |cached| Arc::ptr_eq(cached, cell), bytes);
        }
    }
}

impl Drop for SegmentStore {
    fn drop(&mut self) {
        lock(&self.prefetcher.jobs).closed = true;
        self.prefetcher.wake.notify_all();
    }
}

/// The prefetcher's thread: decodes the newest queued cell into the store, until the store is dropped.
/// A cell that fails to read is left to the search, which reports the error.
fn prefetch_cells(store: &Weak<SegmentStore>, prefetcher: &Prefetcher) {
    let mut iobuffer = Vec::new();
    loop {
        let job = {
            let mut jobs = lock(&prefetcher.jobs);
            loop {
                if jobs.closed {
                    return;
                }
                if let Some(job) = jobs.queue.pop_back() {
                    break job;
                }
                jobs = prefetcher.wake.wait(jobs).unwrap_or_else(PoisonError::into_inner);
            }
        };
        let Some(store) = store.upgrade() else { return };
        if lock(&store.cells).entries.contains_key(&job.key) {
            continue;
        }
        let used = |i: usize| job.lookups_used.get(i).copied().unwrap_or(false);
        if let Ok(ab) = read_cell(&job.file, job.pos, job.len, &mut iobuffer) {
            let cell = DecodedCell::decode(ab, job.key.lon_idx, job.key.lat_idx, job.divisor, &used);
            let bytes = cell.heap_bytes();
            lock(&store.cells).insert(job.key, Arc::new(cell), bytes);
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

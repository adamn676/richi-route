//! Port of `ProfileCache`: parsed profiles are reused when the profile file and the request's
//! `profile:` parameters match, so the way context's result cache carries over between requests.
//!
//! Deviation: Java keeps `2 × threads` slots shared by all worker threads. Expression contexts are
//! `!Send` here, so each worker thread keeps its own cache (give it 2 slots); the reuse rule is Java's.
//! For the planner's profiles a route does not depend on what the result cache holds (the Java
//! baseline is the same across runs with 6 threads), so the cache history does not change results.
//! While a request uses a profile, the profile is out of its slot, which is Java's "busy" flag.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use brouter_expressions::{ExpressionError, NodeContext, Profile, WayContext, read_meta_data};

use crate::java::JavaException;
use crate::routing_context::RoutingContext;

struct Slot {
    profile: Option<Profile>,
    file: PathBuf,
    timestamp: i64,
    last_use: u64,
}

pub struct ProfileCache {
    profile_dir: PathBuf,
    slots: Vec<Option<Slot>>,
    /// The lookup table's modification time when the slots were filled.
    lookup_timestamp: Option<i64>,
    clock: u64,
}

/// `File.lastModified()`: milliseconds since the epoch, 0 if the file is missing.
fn last_modified(file: &Path) -> i64 {
    std::fs::metadata(file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

impl ProfileCache {
    /// Profiles are read from `<profile_dir>/<name>.brf`, the lookup table from
    /// `<profile_dir>/lookups.dat` (BRouter's `profileBaseDir`).
    pub fn new(profile_dir: impl Into<PathBuf>, size: usize) -> Self {
        Self {
            profile_dir: profile_dir.into(),
            slots: (0..size).map(|_| None).collect(),
            lookup_timestamp: None,
            clock: 0,
        }
    }

    /// `new File(profileDir, localFunction + ".brf")`, which appends even an absolute name.
    fn profile_file(&self, rc: &RoutingContext) -> PathBuf {
        let name = format!("{}.brf", rc.local_function.as_deref().unwrap_or_default());
        self.profile_dir.join(name.trim_start_matches('/'))
    }

    /// `parseProfile`: the cached profile for `rc.local_function` and `rc.key_values`, or a freshly
    /// parsed one; `readGlobalConfig` runs either way. Return the profile with `release_profile`.
    pub fn parse_profile(&mut self, rc: &mut RoutingContext) -> Result<Profile, JavaException> {
        let profile_file = self.profile_file(rc);
        rc.profile_timestamp = last_modified(&profile_file).wrapping_add(rc.get_key_value_checksum()).wrapping_shl(24);
        let lookup_file = self.profile_dir.join("lookups.dat");

        // invalidate cache at lookup-table update
        let lookup_timestamp = Some(last_modified(&lookup_file));
        if self.lookup_timestamp != lookup_timestamp {
            self.slots.iter_mut().for_each(|s| *s = None);
            self.lookup_timestamp = lookup_timestamp;
        }

        let mut lru: Option<usize> = None;
        let mut unused_slot: Option<usize> = None;

        // check for re-use
        let last_use = |slots: &[Option<Slot>], i: usize| slots[i].as_ref().map_or(0, |s| s.last_use);
        for i in 0..self.slots.len() {
            let Some(pc) = &self.slots[i] else {
                unused_slot = unused_slot.or(Some(i));
                continue;
            };
            if pc.profile.is_some() && profile_file == pc.file {
                if rc.profile_timestamp == pc.timestamp {
                    let mut profile = self.slots[i].as_mut().and_then(|s| s.profile.take()).expect("checked");
                    rc.read_global_config(&mut profile.way)?;
                    return Ok(profile);
                }
                lru = Some(i); // name-match but timestamp-mismatch -> we override this one
                unused_slot = None;
                break;
            }
            if lru.is_none_or(|l| last_use(&self.slots, l) > pc.last_use) {
                lru = Some(i);
            }
        }

        // Profile::load, step by step: the lookup table's errors come wrapped in a RuntimeException
        let key_values: Vec<(String, String)> =
            rc.key_values.entries().into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let mut way = WayContext::new(rc.memoryclass as usize * 512);
        let mut node = NodeContext::new();
        read_meta_data(&lookup_file, Some(&mut way), Some(&mut node))
            .map_err(|e| JavaException::new("java.lang.RuntimeException", e.0))?;
        way.parse_file(&profile_file, &key_values).map_err(parse_exception)?;
        node.parse_file(&profile_file, &key_values, &mut way).map_err(parse_exception)?;
        let mut profile = Profile { way, node };

        rc.read_global_config(&mut profile.way)?;
        if rc.process_unused_tags {
            profile.way.set_all_tags_used();
        }

        self.clock += 1;
        let slot = Slot { profile: None, file: profile_file, timestamp: rc.profile_timestamp, last_use: self.clock };
        if let Some(i) = unused_slot.or(lru) {
            self.slots[i] = Some(slot);
        }
        Ok(profile)
    }

    /// `releaseProfile`: puts the profile back into its slot, if the slot still belongs to it.
    pub fn release_profile(&mut self, profile: Profile, rc: &RoutingContext) {
        let file = self.profile_file(rc);
        let busy = |s: &&mut Slot| s.profile.is_none() && s.file == file && s.timestamp == rc.profile_timestamp;
        if let Some(slot) = self.slots.iter_mut().flatten().find(busy) {
            slot.profile = Some(profile);
        }
    }
}

/// `parseFile`'s exceptions: `IllegalArgumentException`s, except for I/O errors, which come wrapped in
/// a `RuntimeException` whose message is the cause's `toString()` (`java.io.…`).
fn parse_exception(e: ExpressionError) -> JavaException {
    if e.0.starts_with("java.") {
        JavaException::new("java.lang.RuntimeException", e.0)
    } else {
        JavaException::illegal_argument(e.0)
    }
}

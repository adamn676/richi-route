use std::num::NonZeroU32;
use std::ops::{Index, IndexMut};

/// A reusable arena slot. Generations detect stale handles in tests and debug builds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SlotId {
    slot: NonZeroU32,
    #[cfg(any(test, debug_assertions))]
    generation: u64,
}

impl SlotId {
    /// A synthetic handle for fixtures and heap padding, never for indexing an arena.
    pub fn from_index(index: usize) -> Self {
        let slot = u32::try_from(index)
            .ok()
            .and_then(|i| i.checked_add(1))
            .and_then(NonZeroU32::new)
            .expect("slot arena overflow");
        Self {
            slot,
            #[cfg(any(test, debug_assertions))]
            generation: 0,
        }
    }

    pub fn index(self) -> usize {
        (self.slot.get() - 1) as usize
    }
}

impl Default for SlotId {
    fn default() -> Self {
        Self::from_index(0)
    }
}

/// Stable handles with mark/sweep reclamation. Only unmarked slots are reused.
pub struct SlotArena<T> {
    slots: Vec<Option<T>>,
    marked: Vec<bool>,
    free: Vec<u32>,
    len: usize,
    #[cfg(any(test, debug_assertions))]
    generations: Vec<u64>,
    #[cfg(any(test, debug_assertions))]
    generation: u64,
}

impl<T> Default for SlotArena<T> {
    fn default() -> Self {
        Self {
            slots: Vec::new(),
            marked: Vec::new(),
            free: Vec::new(),
            len: 0,
            #[cfg(any(test, debug_assertions))]
            generations: Vec::new(),
            #[cfg(any(test, debug_assertions))]
            generation: 0,
        }
    }
}

impl<T> SlotArena<T> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, value: T) -> SlotId {
        let index = self.free.last().map_or(self.slots.len(), |&i| i as usize);
        let id = SlotId::from_index(index);
        #[cfg(any(test, debug_assertions))]
        let id = {
            self.generation = self.generation.checked_add(1).expect("slot generation overflow");
            SlotId { generation: self.generation, ..id }
        };
        if self.free.pop().is_some() {
            self.slots[index] = Some(value);
            self.marked[index] = false;
            #[cfg(any(test, debug_assertions))]
            {
                self.generations[index] = id.generation;
            }
        } else {
            self.slots.push(Some(value));
            self.marked.push(false);
            #[cfg(any(test, debug_assertions))]
            self.generations.push(id.generation);
        }
        self.len += 1;
        id
    }

    /// Number of occupied slots.
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Reserved value storage, including space for free slots.
    pub fn capacity(&self) -> usize {
        self.slots.capacity()
    }

    /// Initialized slots, occupied or free, for allocation guards.
    pub fn slots_len(&self) -> usize {
        self.slots.len()
    }

    /// Drops every value, retaining allocations and the generation counter.
    pub fn clear(&mut self) {
        self.slots.clear();
        self.marked.clear();
        self.free.clear();
        self.len = 0;
        #[cfg(any(test, debug_assertions))]
        self.generations.clear();
    }

    fn validate(&self, id: SlotId) -> usize {
        let index = id.index();
        assert!(self.slots[index].is_some(), "vacant slot");
        #[cfg(any(test, debug_assertions))]
        assert_eq!(self.generations[index], id.generation, "stale slot handle");
        index
    }

    pub fn begin_mark(&mut self) {
        self.marked.fill(false);
    }

    /// Validates the handle and returns whether it was newly marked.
    pub fn mark(&mut self, id: SlotId) -> bool {
        let index = id.index();
        #[cfg(any(test, debug_assertions))]
        self.validate(id);
        if self.marked[index] {
            return false;
        }
        assert!(self.slots[index].is_some(), "vacant slot");
        self.marked[index] = true;
        true
    }

    /// Drops unmarked values and makes their slots available to subsequent insertions.
    pub fn sweep(&mut self) {
        for (index, slot) in self.slots.iter_mut().enumerate() {
            if !self.marked[index] && slot.is_some() {
                let value = slot.take();
                self.free.push(index as u32);
                self.len -= 1;
                drop(value);
            }
        }
    }

    /// Occupied values in slot order.
    pub fn iter(&self) -> impl Iterator<Item = &T> {
        self.slots.iter().filter_map(Option::as_ref)
    }
}

impl<T> Index<SlotId> for SlotArena<T> {
    type Output = T;

    fn index(&self, id: SlotId) -> &T {
        let index = self.validate(id);
        self.slots[index].as_ref().expect("occupied slot")
    }
}

impl<T> IndexMut<SlotId> for SlotArena<T> {
    fn index_mut(&mut self, id: SlotId) -> &mut T {
        let index = self.validate(id);
        self.slots[index].as_mut().expect("occupied slot")
    }
}

// Test builds carry generations even with optimizations enabled.
#[cfg(not(any(test, debug_assertions)))]
const _: () = {
    assert!(size_of::<SlotId>() == 4);
    assert!(size_of::<Option<SlotId>>() == 4);
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::rc::Rc;

    #[test]
    fn live_ids_stay_stable_and_sweep_drops_values() {
        let mut arena = SlotArena::new();
        let dropped = Rc::new(1);
        let dead = arena.insert(dropped.clone());
        let live = arena.insert(Rc::new(2));
        arena.begin_mark();
        assert!(arena.mark(live));
        assert!(!arena.mark(live));
        arena.sweep();
        arena.sweep(); // Vacancies must not enter the freelist twice.
        assert_eq!(Rc::strong_count(&dropped), 1);
        assert_eq!(arena.len(), 1);
        assert_eq!(arena.slots_len(), 2);
        assert_eq!(*arena[live], 2);
        let reused = arena.insert(Rc::new(3));
        assert_eq!(reused.index(), dead.index());
        assert_ne!(reused, dead);
        arena[live] = Rc::new(4);
        assert_eq!(arena.iter().map(|v| **v).collect::<Vec<_>>(), vec![3, 4]);
        let appended = arena.insert(Rc::new(5));
        assert_eq!(appended.index(), 2);
        arena.begin_mark();
        arena.sweep();
        assert!(arena.is_empty());
        assert_eq!(arena.slots_len(), 3);
    }

    #[test]
    #[should_panic(expected = "stale slot handle")]
    fn stale_after_reuse_panics() {
        let mut arena = SlotArena::new();
        let stale = arena.insert(1);
        arena.begin_mark();
        arena.sweep();
        arena.insert(2);
        let _ = arena[stale];
    }

    #[test]
    #[should_panic(expected = "stale slot handle")]
    fn stale_after_clear_panics() {
        let mut arena = SlotArena::new();
        let stale = arena.insert(1);
        let capacity = arena.capacity();
        arena.clear();
        assert_eq!(arena.slots_len(), 0);
        assert_eq!(arena.capacity(), capacity);
        arena.insert(2);
        arena[stale] = 3;
    }

    #[test]
    #[should_panic(expected = "stale slot handle")]
    fn mark_validates_generation() {
        let mut arena = SlotArena::new();
        let stale = arena.insert(1);
        arena.clear();
        arena.insert(2);
        arena.mark(stale);
    }

    #[test]
    #[should_panic(expected = "vacant slot")]
    fn vacant_handle_panics() {
        let mut arena = SlotArena::new();
        let stale = arena.insert(1);
        arena.sweep();
        let _ = arena[stale];
    }

    #[test]
    #[should_panic(expected = "stale slot handle")]
    fn dummy_is_not_an_arena_handle() {
        let mut arena = SlotArena::new();
        arena.insert(1);
        let _ = arena[SlotId::default()];
    }
}

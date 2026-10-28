use crate::{ByteArrayUnifier, Description, crc};

/// Port of the class `ByteArrayUnifier` (the trait of that name ports `IByteArrayUnifier`): a fixed-size,
/// CRC-indexed cache where a new array replaces whatever shared its slot. Java's optional immutability
/// check is left out, since a `Description` cannot change. The slots are allocated on first use: every
/// search creates a cache, and with direct weaving it is never used.
pub struct ByteArrayCache {
    size: usize,
    cache: Vec<Option<Description>>,
}

impl ByteArrayCache {
    pub fn new(size: usize) -> Self {
        Self { size, cache: Vec::new() }
    }
}

impl ByteArrayUnifier for ByteArrayCache {
    fn unify(&mut self, ab: &[u8], offset: usize, len: usize) -> Description {
        if self.cache.is_empty() {
            self.cache = vec![None; self.size];
        }
        let crc = crc(ab, offset, len);
        let idx = (crc & 0xfff_ffff) as usize % self.size;
        let wanted = &ab[offset..offset + len];
        if let Some(cached) = &self.cache[idx]
            && **cached == *wanted
        {
            return cached.clone();
        }
        let nab: Description = wanted.into();
        self.cache[idx] = Some(nab.clone());
        nab
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::rc::Rc;

    #[test]
    fn unifies_equal_content() {
        let mut cache = ByteArrayCache::new(16_384);
        let a = cache.unify(&[9, 1, 2, 3], 1, 3);
        let b = cache.unify(&[1, 2, 3], 0, 3);
        assert!(Rc::ptr_eq(&a, &b));
        assert_eq!(&*a, &[1, 2, 3]);
        let c = cache.unify(&[1, 2, 4], 0, 3);
        assert!(!Rc::ptr_eq(&a, &c));
    }
}

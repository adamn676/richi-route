/// Port of `DataBuffers`: scratch buffers the decoders reuse between micro caches. Java hands out fixed
/// arrays and allocates bigger ones when they are too small; here the vectors grow instead, and the
/// decoders take them out and put them back.
#[derive(Default)]
pub struct DataBuffers {
    /// Raw micro cache bytes read from the file.
    pub iobuffer: Vec<u8>,
    /// Re-encoded tag sets.
    pub tagbuf1: Vec<u8>,
    /// Decoded node data (`MicroCache2`).
    pub bbuf1: Vec<u8>,
    /// Reverse-link lists.
    pub ibuf1: Vec<i32>,
    /// Node ids.
    pub ibuf2: Vec<i32>,
    /// Node data offsets.
    pub ibuf3: Vec<i32>,
    pub alon: Vec<i32>,
    pub alat: Vec<i32>,
}

impl DataBuffers {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Port of `LinkedListContainer`: a fixed number of integer lists in one array, read back last in,
/// first out.
pub struct LinkedListContainer {
    /// prev, data, prev, data, ...
    ia: Vec<i32>,
    /// 0 = empty, else 1 + the index of the list head's data cell.
    startpointer: Vec<i32>,
    listpointer: i32,
}

impl LinkedListContainer {
    /// A container for `nlists` lists, reusing `buffer`'s allocation (Java: `defaultbuffer`).
    pub fn new(nlists: usize, mut buffer: Vec<i32>) -> Self {
        buffer.clear();
        if buffer.capacity() == 0 {
            buffer.reserve(nlists * 4);
        }
        Self { ia: buffer, startpointer: vec![0; nlists], listpointer: 0 }
    }

    pub fn add_data_element(&mut self, list_nr: usize, data: i32) {
        self.ia.push(self.startpointer[list_nr]);
        self.startpointer[list_nr] = self.ia.len() as i32;
        self.ia.push(data);
    }

    /// Prepares `list_nr` for reading and returns its length.
    pub fn init_list(&mut self, list_nr: usize) -> i32 {
        let mut cnt = 0;
        self.listpointer = self.startpointer[list_nr];
        let mut lp = self.listpointer;
        while lp != 0 {
            lp = self.ia[lp as usize - 1];
            cnt += 1;
        }
        cnt
    }

    /// The next element of the list prepared by `init_list`, newest first.
    pub fn get_data_element(&mut self) -> i32 {
        if self.listpointer == 0 {
            panic!("no more element!");
        }
        let data = self.ia[self.listpointer as usize];
        self.listpointer = self.ia[self.listpointer as usize - 1];
        data
    }

    /// Returns the buffer for reuse.
    pub fn into_buffer(self) -> Vec<i32> {
        self.ia
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_are_lifo() {
        let mut c = LinkedListContainer::new(3, Vec::new());
        c.add_data_element(1, 10);
        c.add_data_element(2, 20);
        c.add_data_element(1, 11);
        assert_eq!(c.init_list(0), 0);
        assert_eq!(c.init_list(1), 2);
        assert_eq!(c.get_data_element(), 11);
        assert_eq!(c.get_data_element(), 10);
        assert_eq!(c.init_list(2), 1);
        assert_eq!(c.get_data_element(), 20);
    }
}

use crate::{DataBuffers, TagValueValidator};
use brouter_util::{BitCoderContext, BitWriter, Description};

/// Port of `TagValueWrapper`: a description bitmap with its access type.
#[derive(Clone, Debug)]
pub struct TagValueWrapper {
    pub data: Description,
    pub access_type: i32,
}

impl TagValueWrapper {
    /// A way tag set as `TagValueCoder.decodeTree` keeps it: unified through the validator, then
    /// `None` if its access type is 0.
    pub fn validated(validator: &mut dyn TagValueValidator, ab: &[u8], offset: usize, len: usize) -> Option<Self> {
        let data = validator.unify(ab, offset, len);
        let access_type = validator.access_type(&data);
        (access_type > 0).then_some(Self { data, access_type })
    }
}

#[derive(Clone, Copy)]
enum TreeNode {
    Node(u32, u32),
    Leaf(u32),
}

/// The Huffman tree of a micro cache's way or node descriptions as stored, before any validator has
/// seen it: each leaf is the list of (lookup index, value) pairs it encodes. Java links tree nodes as
/// objects; here they sit in a vector with the root at index 0.
pub struct TagTree {
    tree: Vec<TreeNode>,
    /// End of each leaf's pairs in `pairs`, in tree order (depth first, `child1` before `child2`).
    leaf_ends: Vec<u32>,
    /// `(inum, data)`: absolute lookup index and value index.
    pairs: Vec<(i32, i32)>,
}

impl TagTree {
    pub fn decode(bc: &mut BitCoderContext) -> Self {
        let mut t = Self { tree: Vec::new(), leaf_ends: Vec::new(), pairs: Vec::new() };
        t.decode_tree(bc);
        t
    }

    fn decode_tree(&mut self, bc: &mut BitCoderContext) -> u32 {
        let idx = self.tree.len() as u32;
        if bc.decode_bit() {
            self.tree.push(TreeNode::Node(0, 0));
            let child1 = self.decode_tree(bc);
            let child2 = self.decode_tree(bc);
            self.tree[idx as usize] = TreeNode::Node(child1, child2);
        } else {
            let mut inum = 0i32;
            loop {
                let delta = bc.decode_var_bits();
                if delta == 0 {
                    break;
                }
                inum = inum.wrapping_add(delta);
                self.pairs.push((inum, bc.decode_var_bits()));
            }
            self.tree.push(TreeNode::Leaf(self.leaf_ends.len() as u32));
            self.leaf_ends.push(self.pairs.len() as u32);
        }
        idx
    }

    pub fn leaf_count(&self) -> usize {
        self.leaf_ends.len()
    }

    /// The distinct lookup indices the leaves use, sorted.
    pub fn lookup_indices(&self) -> Vec<i32> {
        let mut inums: Vec<i32> = self.pairs.iter().map(|&(inum, _)| inum).collect();
        inums.sort_unstable();
        inums.dedup();
        inums
    }

    /// Walks the tree by the next bits of `bc` and returns the leaf's index.
    pub fn decode_leaf(&self, bc: &mut BitCoderContext) -> u32 {
        let mut node = self.tree[0];
        loop {
            match node {
                TreeNode::Node(child1, child2) => {
                    node = self.tree[if bc.decode_bit() { child2 } else { child1 } as usize]
                }
                TreeNode::Leaf(leaf) => return leaf,
            }
        }
    }

    /// Re-encodes the leaf's pairs whose lookup index passes `used` into `out`, as
    /// `TagValueCoder.decodeTree` does into `DataBuffers.tagbuf1`. `None` when no pair passes: Java's
    /// `null` leaf.
    pub fn encode_leaf<'a>(
        &self,
        leaf: u32,
        mut used: impl FnMut(i32) -> bool,
        out: &'a mut Vec<u8>,
    ) -> Option<&'a [u8]> {
        let start = if leaf == 0 { 0 } else { self.leaf_ends[leaf as usize - 1] as usize };
        let pairs = &self.pairs[start..self.leaf_ends[leaf as usize] as usize];
        let mut ctx = BitWriter::with_buffer(std::mem::take(out));
        let mut last_encoded_inum = 0i32;
        let mut hasdata = false;
        for &(inum, data) in pairs {
            if used(inum) {
                hasdata = true;
                ctx.encode_var_bits(inum.wrapping_sub(last_encoded_inum));
                ctx.encode_var_bits(data);
                last_encoded_inum = inum;
            }
        }
        if hasdata {
            ctx.encode_var_bits(0);
        }
        *out = ctx.finish();
        hasdata.then_some(&out[..])
    }
}

/// Decoding side of `TagValueCoder`: the tree of a micro cache's way or node descriptions with the
/// leaves the validator kept.
pub(crate) struct TagValueCoder {
    tree: TagTree,
    leaves: Vec<Option<TagValueWrapper>>,
}

impl TagValueCoder {
    /// Reads the tree. With a validator, a leaf keeps only the lookups it uses and is validated
    /// (`TagValueWrapper::validated`); without one it is a fresh copy. Java reads a leaf and passes it
    /// to the validator before reading the next; the validator sees the same leaves in the same order
    /// here, and reading the bits has no other effect.
    pub(crate) fn new(
        bc: &mut BitCoderContext,
        buffers: &mut DataBuffers,
        mut validator: Option<&mut dyn TagValueValidator>,
    ) -> Self {
        let tree = TagTree::decode(bc);
        let tagbuf = &mut buffers.tagbuf1;
        let leaves = (0..tree.leaf_count() as u32)
            .map(|leaf| {
                let used = |inum: i32| validator.as_deref().is_none_or(|v| v.is_lookup_idx_used(inum as usize));
                let tags = tree.encode_leaf(leaf, used, tagbuf)?;
                match validator.as_deref_mut() {
                    None => Some(TagValueWrapper { data: tags.into(), access_type: 2 }),
                    Some(v) => TagValueWrapper::validated(v, tags, 0, tags.len()),
                }
            })
            .collect();
        Self { tree, leaves }
    }

    /// Walks the tree by the next bits of `bc`.
    pub(crate) fn decode_tag_value_set(&self, bc: &mut BitCoderContext) -> Option<&TagValueWrapper> {
        self.leaves[self.tree.decode_leaf(bc) as usize].as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tree with two leaves: `{1: 5, 4: 2}` and the empty leaf.
    fn sample() -> Vec<u8> {
        let mut bw = BitWriter::new();
        bw.encode_bit(true); // node
        bw.encode_bit(false); // leaf 0
        for v in [1, 5, 3, 2, 0] {
            bw.encode_var_bits(v);
        }
        bw.encode_bit(false); // leaf 1
        bw.encode_var_bits(0);
        bw.encode_bit(true); // walk: child2
        bw.encode_bit(false); // walk: child1
        bw.finish()
    }

    #[test]
    fn leaves_filter_and_walk() {
        let ab = sample();
        let mut bc = BitCoderContext::new(&ab);
        let tree = TagTree::decode(&mut bc);
        assert_eq!(tree.leaf_count(), 2);
        assert_eq!(tree.decode_leaf(&mut bc), 1);
        assert_eq!(tree.decode_leaf(&mut bc), 0);

        let mut all = Vec::new();
        assert!(tree.encode_leaf(0, |_| true, &mut all).is_some());
        let mut only4 = Vec::new();
        assert!(tree.encode_leaf(0, |inum| inum == 4, &mut only4).is_some());
        let mut none = vec![9];
        assert_eq!(tree.encode_leaf(0, |_| false, &mut none), None);
        assert!(none.is_empty());
        assert_eq!(tree.encode_leaf(1, |_| true, &mut none), None);

        let mut bc = BitCoderContext::new(&only4);
        assert_eq!((bc.decode_var_bits(), bc.decode_var_bits(), bc.decode_var_bits()), (4, 2, 0));
        let mut bc = BitCoderContext::new(&all);
        let values: Vec<i32> = (0..5).map(|_| bc.decode_var_bits()).collect();
        assert_eq!(values, [1, 5, 3, 2, 0]);
        assert_eq!(tree.lookup_indices(), [1, 4]);
    }
}

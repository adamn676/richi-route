use crate::{DataBuffers, TagValueValidator};
use brouter_util::{BitCoderContext, BitWriter, Description};

/// Port of `TagValueWrapper`: a description bitmap with its access type.
#[derive(Clone, Debug)]
pub struct TagValueWrapper {
    pub data: Description,
    pub access_type: i32,
}

enum TreeNode {
    Node(u32, u32),
    Leaf(Option<TagValueWrapper>),
}

/// Decoding side of `TagValueCoder`: the Huffman tree of a micro cache's way or node descriptions.
/// Java links tree nodes as objects; here they sit in a vector with the root at index 0.
pub struct TagValueCoder {
    tree: Vec<TreeNode>,
}

impl TagValueCoder {
    /// Reads the tree. With a validator, the leaves keep only the lookups it uses, are unified through
    /// it and are dropped when their access type is 0; without one they are fresh copies.
    pub fn new(
        bc: &mut BitCoderContext,
        buffers: &mut DataBuffers,
        mut validator: Option<&mut dyn TagValueValidator>,
    ) -> Self {
        let mut coder = Self { tree: Vec::new() };
        coder.decode_tree(bc, buffers, &mut validator);
        coder
    }

    /// Walks the tree by the next bits of `bc`.
    pub fn decode_tag_value_set(&self, bc: &mut BitCoderContext) -> Option<&TagValueWrapper> {
        let mut node = &self.tree[0];
        loop {
            match node {
                TreeNode::Node(child1, child2) => {
                    let next = if bc.decode_bit() { child2 } else { child1 };
                    node = &self.tree[*next as usize];
                }
                TreeNode::Leaf(leaf) => return leaf.as_ref(),
            }
        }
    }

    fn decode_tree(
        &mut self,
        bc: &mut BitCoderContext,
        buffers: &mut DataBuffers,
        validator: &mut Option<&mut dyn TagValueValidator>,
    ) -> u32 {
        let idx = self.tree.len() as u32;
        if bc.decode_bit() {
            self.tree.push(TreeNode::Node(0, 0));
            let child1 = self.decode_tree(bc, buffers, validator);
            let child2 = self.decode_tree(bc, buffers, validator);
            self.tree[idx as usize] = TreeNode::Node(child1, child2);
        } else {
            let leaf = Self::decode_leaf(bc, buffers, validator);
            self.tree.push(TreeNode::Leaf(leaf));
        }
        idx
    }

    fn decode_leaf(
        bc: &mut BitCoderContext,
        buffers: &mut DataBuffers,
        validator: &mut Option<&mut dyn TagValueValidator>,
    ) -> Option<TagValueWrapper> {
        // Java re-encodes into DataBuffers.tagbuf1; the writer buffer is reused the same way.
        let mut ctx = BitWriter::with_buffer(std::mem::take(&mut buffers.tagbuf1));

        let mut inum = 0i32;
        let mut last_encoded_inum = 0i32;
        let mut hasdata = false;
        loop {
            let delta = bc.decode_var_bits();
            if !hasdata && delta == 0 {
                buffers.tagbuf1 = ctx.finish();
                return None;
            }
            if delta == 0 {
                ctx.encode_var_bits(0);
                break;
            }
            inum = inum.wrapping_add(delta);

            let data = bc.decode_var_bits();

            if validator.as_deref().is_none_or(|v| v.is_lookup_idx_used(inum as usize)) {
                hasdata = true;
                ctx.encode_var_bits(inum - last_encoded_inum);
                ctx.encode_var_bits(data);
                last_encoded_inum = inum;
            }
        }

        let buffer = ctx.finish();
        let (res, access_type): (Description, i32) = match validator.as_deref_mut() {
            None => (buffer.as_slice().into(), 2),
            Some(v) => {
                let res = v.unify(&buffer, 0, buffer.len());
                let access_type = v.access_type(&res);
                (res, access_type)
            }
        };
        buffers.tagbuf1 = buffer;
        (access_type > 0).then_some(TagValueWrapper { data: res, access_type })
    }
}

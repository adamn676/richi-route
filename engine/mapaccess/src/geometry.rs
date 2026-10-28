use crate::OsmNode;
use brouter_util::ByteDataReader;
use std::rc::Rc;

/// Port of `OsmTransferNode`: an intermediate point of a link's geometry.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OsmTransferNode {
    pub ilon: i32,
    pub ilat: i32,
    pub selev: i16,
}

/// Port of `GeometryDecoder`. Java returns the head of a linked list built from reused nodes; this
/// returns the same nodes as a slice in list order, valid until the next call. Like Java it caches the
/// last result by geometry identity and direction.
#[derive(Default)]
pub struct GeometryDecoder {
    nodes: Vec<OsmTransferNode>,
    last: Option<(Rc<[u8]>, bool)>,
}

impl GeometryDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// The transfer nodes from `source_node` to `target_node` (empty for Java's `null`). The geometry is
    /// stored from the link's forward source, so a reverse link decodes from `target_node` and returns
    /// the nodes in reverse order.
    pub fn decode_geometry(
        &mut self,
        geometry: &Rc<[u8]>,
        source_node: &OsmNode,
        target_node: &OsmNode,
        reverse_link: bool,
    ) -> &[OsmTransferNode] {
        if let Some((last_geometry, last_reverse)) = &self.last
            && Rc::ptr_eq(last_geometry, geometry)
            && *last_reverse == reverse_link
        {
            return &self.nodes;
        }

        self.nodes.clear();
        let startnode = if reverse_link { target_node } else { source_node };
        let mut r = ByteDataReader::new(geometry);
        let mut olon = startnode.ilon;
        let mut olat = startnode.ilat;
        let mut oselev = i32::from(startnode.selev);
        while r.has_more_data() {
            let ilon = olon.wrapping_add(r.read_var_length_signed());
            let ilat = olat.wrapping_add(r.read_var_length_signed());
            let selev = oselev.wrapping_add(r.read_var_length_signed()) as i16;
            self.nodes.push(OsmTransferNode { ilon, ilat, selev });
            olon = ilon;
            olat = ilat;
            oselev = i32::from(selev);
        }
        if reverse_link {
            self.nodes.reverse(); // reverse chaining
        }

        self.last = Some((geometry.clone(), reverse_link));
        &self.nodes
    }
}

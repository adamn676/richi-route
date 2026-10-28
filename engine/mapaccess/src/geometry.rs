use crate::OsmNode;
use brouter_util::ByteDataReader;
use std::ops::Deref;
use std::rc::Rc;
use std::sync::Arc;

/// A link's transfer nodes in the forward direction (`OsmLink::geometry`, Java's `byte[] geometry`):
/// a slice of the geometry of the cell it was decoded from, shared by the links woven from that cell.
/// Two `Geometry`s are the same array in Java's sense when `same` says so.
#[derive(Clone, Debug)]
pub struct Geometry {
    cell: Rc<Arc<[u8]>>,
    start: u32,
    end: u32,
}

impl Geometry {
    /// The links of one woven cell share `cell`.
    pub(crate) fn new(cell: &Rc<Arc<[u8]>>, start: usize, end: usize) -> Self {
        Self { cell: cell.clone(), start: start as u32, end: end as u32 }
    }

    /// Java's reference comparison.
    pub fn same(&self, other: &Geometry) -> bool {
        Rc::ptr_eq(&self.cell, &other.cell) && self.start == other.start
    }
}

impl From<&[u8]> for Geometry {
    fn from(ab: &[u8]) -> Self {
        Self::new(&Rc::new(Arc::from(ab)), 0, ab.len())
    }
}

impl Deref for Geometry {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.cell[self.start as usize..self.end as usize]
    }
}

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
    last: Option<(Geometry, bool)>,
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
        geometry: &Geometry,
        source_node: &OsmNode,
        target_node: &OsmNode,
        reverse_link: bool,
    ) -> &[OsmTransferNode] {
        if let Some((last_geometry, last_reverse)) = &self.last
            && last_geometry.same(geometry)
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

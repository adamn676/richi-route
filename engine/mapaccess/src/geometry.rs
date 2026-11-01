use crate::{OsmNode, OsmNodesMap};
use brouter_util::ByteDataReader;
use std::num::NonZeroU32;
use std::ops::Range;

/// A link's transfer nodes in the forward direction (`OsmLink::geometry`, Java's `byte[] geometry`):
/// a slice of the geometry of the cell it was woven from, which `OsmNodesMap::geometry` reads. The
/// links of one weave share the cell. Two `Geometry`s are the same array in Java's sense when `same`
/// says so.
#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    /// The cell's position in the map's table, plus one so that `Option<Geometry>` takes 12 bytes.
    cell: NonZeroU32,
    start: u32,
    end: u32,
}

impl Geometry {
    pub(crate) fn new(cell: usize, start: usize, end: usize) -> Self {
        let cell = u32::try_from(cell + 1).ok().and_then(NonZeroU32::new).expect("geometry table overflow");
        Self { cell, start: start as u32, end: end as u32 }
    }

    pub(crate) fn cell(self) -> usize {
        (self.cell.get() - 1) as usize
    }

    pub(crate) fn range(self) -> Range<usize> {
        self.start as usize..self.end as usize
    }

    /// Java's reference comparison (within one map).
    pub fn same(&self, other: &Geometry) -> bool {
        self.cell == other.cell && self.start == other.start
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
    /// The last geometry decoded, with the id of its map and the direction.
    last: Option<(u64, Geometry, bool)>,
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
        map: &OsmNodesMap,
        geometry: Geometry,
        source_node: &OsmNode,
        target_node: &OsmNode,
        reverse_link: bool,
    ) -> &[OsmTransferNode] {
        if let Some((last_map, last_geometry, last_reverse)) = &self.last
            && *last_map == map.id()
            && last_geometry.same(&geometry)
            && *last_reverse == reverse_link
        {
            return &self.nodes;
        }

        self.nodes.clear();
        let startnode = if reverse_link { target_node } else { source_node };
        let mut r = ByteDataReader::new(map.geometry(geometry));
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

        self.last = Some((map.id(), geometry, reverse_link));
        &self.nodes
    }
}

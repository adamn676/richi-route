use brouter_util::{cheap_ruler, jmath};

/// Port of `OsmPos`: a position (node, path element, ...) in integer coordinates
/// (`(lon + 180) * 1e6`, `(lat + 90) * 1e6`) with an elevation in quarter meters.
pub trait OsmPos {
    fn ilon(&self) -> i32;
    fn ilat(&self) -> i32;
    fn selev(&self) -> i16;

    fn elev(&self) -> f64 {
        f64::from(self.selev()) / 4.
    }

    /// Distance in whole meters, at least 1 (`OsmNode.calcDistance`).
    fn calc_distance(&self, p: &dyn OsmPos) -> i32 {
        let d = cheap_ruler::distance(self.ilon(), self.ilat(), p.ilon(), p.ilat());
        f64::max(1.0, jmath::round(d) as f64) as i32
    }

    /// `((long) ilon) << 32 | ilat`, including Java's sign extension of `ilat`.
    fn id_from_pos(&self) -> i64 {
        (i64::from(self.ilon()) << 32) | i64::from(self.ilat())
    }
}

/// A bare position: what Java models as a free-standing `OsmNode` outside the graph (waypoints, cross
/// points, the nodes of a matched way). Its elevation is unknown (`Short.MIN_VALUE`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Pos {
    pub ilon: i32,
    pub ilat: i32,
}

impl Pos {
    pub fn new(ilon: i32, ilat: i32) -> Self {
        Self { ilon, ilat }
    }

    /// `new OsmNode(long id)`.
    pub fn from_id(id: i64) -> Self {
        Self { ilon: (id >> 32) as i32, ilat: id as i32 }
    }

    /// `OsmNode.hashCode()`, which BRouter also prints into matched waypoint names.
    pub fn hash_code(&self) -> i32 {
        self.ilon.wrapping_add(self.ilat)
    }
}

impl OsmPos for Pos {
    fn ilon(&self) -> i32 {
        self.ilon
    }
    fn ilat(&self) -> i32 {
        self.ilat
    }
    fn selev(&self) -> i16 {
        i16::MIN
    }
}

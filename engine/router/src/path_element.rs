//! Port of `OsmPathElement`: the points of a found path, chained backwards through `origin`. Tracks,
//! search paths and the guide track share elements and change them in place (times, costs,
//! elevations), so they live in an arena per routing request and are addressed by `ElemIdx`.

use std::num::NonZeroU32;
use std::ops::{Index, IndexMut};

use brouter_mapaccess::OsmPos;

use crate::message_data::MessageData;

/// The arena position plus one, so that `Option<ElemIdx>` takes four bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ElemIdx(NonZeroU32);

impl ElemIdx {
    fn index(self) -> usize {
        (self.0.get() - 1) as usize
    }
}

#[derive(Clone, Debug)]
pub struct OsmPathElement {
    pub ilat: i32,
    pub ilon: i32,
    pub selev: i16,
    pub message: Option<Box<MessageData>>,
    pub cost: i32,
    pub origin: Option<ElemIdx>,
}

impl OsmPathElement {
    pub fn time(&self) -> f32 {
        self.message.as_ref().map_or(0.0, |m| m.time)
    }

    pub fn set_time(&mut self, t: f32) {
        if let Some(m) = &mut self.message {
            m.time = t;
        }
    }

    pub fn energy(&self) -> f32 {
        self.message.as_ref().map_or(0.0, |m| m.energy)
    }

    pub fn set_energy(&mut self, e: f32) {
        if let Some(m) = &mut self.message {
            m.energy = e;
        }
    }

    pub fn position_equals(&self, e: &OsmPathElement) -> bool {
        self.ilat == e.ilat && self.ilon == e.ilon
    }
}

impl OsmPos for OsmPathElement {
    fn ilon(&self) -> i32 {
        self.ilon
    }
    fn ilat(&self) -> i32 {
        self.ilat
    }
    fn selev(&self) -> i16 {
        self.selev
    }
}

/// The element arena of one routing request; nothing is freed before the request ends.
#[derive(Default)]
pub struct PathElements(Vec<OsmPathElement>);

impl PathElements {
    /// `OsmPathElement.create(ilon, ilat, selev, origin)`.
    pub fn create(&mut self, ilon: i32, ilat: i32, selev: i16, origin: Option<ElemIdx>) -> ElemIdx {
        self.push(OsmPathElement { ilat, ilon, selev, message: None, cost: 0, origin })
    }

    pub fn clear(&mut self) {
        self.0.clear();
    }

    pub fn push(&mut self, element: OsmPathElement) -> ElemIdx {
        let idx = u32::try_from(self.0.len() + 1).ok().and_then(NonZeroU32::new).expect("path element arena overflow");
        let idx = ElemIdx(idx);
        self.0.push(element);
        idx
    }
}

impl Index<ElemIdx> for PathElements {
    type Output = OsmPathElement;
    fn index(&self, i: ElemIdx) -> &OsmPathElement {
        &self.0[i.index()]
    }
}

impl IndexMut<ElemIdx> for PathElements {
    fn index_mut(&mut self, i: ElemIdx) -> &mut OsmPathElement {
        &mut self.0[i.index()]
    }
}

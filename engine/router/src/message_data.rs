//! Port of `MessageData`: what a track point records about the way section leading to it.

/// Left out: the speed-profile fields (`vmax`, `vnode0`, ...), which only kinematic models set, and the
/// turn angle, priority and classifier mask, which only voice hints read.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MessageData {
    pub linkdist: i32,
    pub linkelevationcost: i32,
    pub linkturncost: i32,
    pub linknodecost: i32,
    pub linkinitcost: i32,

    pub costfactor: f32,
    pub way_key_values: Option<String>,
    pub node_key_values: Option<String>,

    pub lon: i32,
    pub lat: i32,
    pub ele: i16,

    pub time: f32,
    pub energy: f32,
}

impl MessageData {
    /// One line of the track's message table (tab-separated), `None` without way tags.
    pub fn to_message(&self) -> Option<String> {
        let way_key_values = self.way_key_values.as_ref()?;
        let i_cost = (self.costfactor * 1000.0 + 0.5) as i32;
        Some(format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            self.lon.wrapping_sub(180_000_000),
            self.lat.wrapping_sub(90_000_000),
            self.ele / 4,
            self.linkdist,
            i_cost,
            self.linkelevationcost,
            self.linkturncost,
            self.linknodecost,
            self.linkinitcost,
            way_key_values,
            self.node_key_values.as_deref().unwrap_or(""),
            self.time as i32,
            self.energy as i32,
        ))
    }

    pub fn add(&mut self, d: &MessageData) {
        self.linkdist = self.linkdist.wrapping_add(d.linkdist);
        self.linkelevationcost = self.linkelevationcost.wrapping_add(d.linkelevationcost);
        self.linkturncost = self.linkturncost.wrapping_add(d.linkturncost);
        self.linknodecost = self.linknodecost.wrapping_add(d.linknodecost);
        self.linkinitcost = self.linkinitcost.wrapping_add(d.linkinitcost);
    }
}

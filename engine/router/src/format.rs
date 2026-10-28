//! Ports of `FormatJson.format` (GeoJSON) and the `Formatter` helpers it uses. Numbers are written
//! exactly as Java's `StringBuilder` and `DecimalFormat` write them.

use std::fmt::Write;

use brouter_mapaccess::OsmPos;

use crate::java::{double_to_string, float_to_string, format_0_000};
use crate::path_element::PathElements;
use crate::track::OsmTrack;

/// `OsmTrack.version`: the implementation version of the BRouter jar.
pub const VERSION: &str = "1.7.10";

const MESSAGES_HEADER: &str = "Longitude\tLatitude\tElevation\tDistance\tCostPerKm\tElevCost\tTurnCost\tNodeCost\tInitialCost\tWayTags\tNodeTags\tTime\tEnergy";

pub fn format_ilon(ilon: i32) -> String {
    format_pos(ilon.wrapping_sub(180_000_000))
}

pub fn format_ilat(ilat: i32) -> String {
    format_pos(ilat.wrapping_sub(90_000_000))
}

/// Six decimals, at least one integer digit.
fn format_pos(mut p: i32) -> String {
    let negative = p < 0;
    if negative {
        p = p.wrapping_neg();
    }
    let mut ac = [0u8; 12];
    let mut i = 11usize;
    while p != 0 || i > 3 {
        ac[i] = b'0' + (p % 10).unsigned_abs() as u8;
        i -= 1;
        p /= 10;
        if i == 5 {
            ac[i] = b'.';
            i -= 1;
        }
    }
    if negative {
        ac[i] = b'-';
        i -= 1;
    }
    String::from_utf8_lossy(&ac[i + 1..12]).into_owned()
}

/// `String.replaceAll("\t", "\", \"")` on a table line.
fn json_cells(line: &str) -> String {
    line.replace('\t', "\", \"")
}

/// `StringBuilder.deleteCharAt(lastIndexOf(","))`.
fn delete_last_comma(sb: &mut String) {
    if let Some(i) = sb.rfind(',') {
        sb.remove(i);
    }
}

/// `FormatJson.format` for a routed track: without voice hints (none without turn instructions),
/// speed profile (empty without a kinematic model), waypoint export (only when writing files) and pois
/// (not supported).
pub fn format_json(t: &OsmTrack, elements: &PathElements) -> String {
    let mut sb = String::with_capacity(8192);
    let total_seconds = t.total_seconds(elements);

    sb.push_str("{\n");
    sb.push_str("  \"type\": \"FeatureCollection\",\n");
    sb.push_str("  \"features\": [\n");
    sb.push_str("    {\n");
    sb.push_str("      \"type\": \"Feature\",\n");
    sb.push_str("      \"properties\": {\n");
    let properties = [
        ("creator", format!("BRouter-{VERSION}")),
        ("name", t.name.clone()),
        ("track-length", t.distance.to_string()),
        ("filtered ascend", t.ascend.to_string()),
        ("plain-ascend", t.plain_ascend.to_string()),
        ("total-time", total_seconds.to_string()),
        ("total-energy", t.energy.to_string()),
        ("cost", t.cost.to_string()),
    ];
    for (key, value) in properties {
        let _ = writeln!(sb, "        \"{key}\": \"{value}\",");
    }

    sb.push_str("        \"messages\": [\n");
    let _ = writeln!(sb, "          [\"{}\"],", json_cells(MESSAGES_HEADER));
    for m in t.aggregate_messages(elements) {
        let _ = writeln!(sb, "          [\"{}\"],", json_cells(&m));
    }
    delete_last_comma(&mut sb);
    sb.push_str("        ],\n");

    if total_seconds > 0 {
        sb.push_str("        \"times\": [");
        for &n in &t.nodes {
            sb.push_str(&format_0_000(elements[n].time()));
            sb.push(',');
        }
        delete_last_comma(&mut sb);
        sb.push_str("]\n");
    } else {
        delete_last_comma(&mut sb);
    }

    sb.push_str("      },\n");
    sb.push_str("      \"geometry\": {\n");
    sb.push_str("        \"type\": \"LineString\",\n");
    sb.push_str("        \"coordinates\": [\n");

    let mut nn = None;
    for &i in &t.nodes {
        let n = &elements[i];
        let sele = if t.showspeed {
            // hack: show speed instead of elevation
            let mut speed = 0.0;
            if let Some(nn) = nn.map(|j| &elements[j]) {
                let dist = n.calc_distance(nn);
                let dt = n.time() - nn.time();
                if dt != 0.0 {
                    speed = f64::from((3.6 * dist as f32) / dt) + 0.5;
                }
            }
            format!(", {}", float_to_string((speed * 10.0) as i32 as f32 / 10.0))
        } else if n.selev == i16::MIN {
            String::new()
        } else {
            format!(", {}", double_to_string(n.elev()))
        };
        let _ = writeln!(sb, "          [{}, {}{sele}],", format_ilon(n.ilon), format_ilat(n.ilat));
        nn = Some(i);
    }
    delete_last_comma(&mut sb);

    sb.push_str("        ]\n");
    sb.push_str("      }\n");
    sb.push_str("    }\n");
    sb.push_str("  ]\n");
    sb.push_str("}\n");
    sb
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positions() {
        assert_eq!(format_ilon(195_439_328), "15.439328");
        assert_eq!(format_ilat(137_070_641), "47.070641");
        assert_eq!(format_ilon(179_999_999), "-0.000001");
        assert_eq!(format_ilon(180_000_000), "0.000000");
        assert_eq!(format_ilat(0), "-90.000000");
    }
}

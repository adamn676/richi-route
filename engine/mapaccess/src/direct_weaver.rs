//! Port of `DirectWeaver`: decodes a cell like `MicroCache2` does, but straight into the graph.

use crate::{NodeIdx, OsmNodesMap, TurnRestriction};
use brouter_codec::{
    DataBuffers, NoisyDiffCoder, StatCoderContext, TagValueCoder, TagValueValidator, WaypointMatcher,
    decode_transfer_nodes, expand_id32,
};
use brouter_util::ByteDataWriter;
use std::rc::Rc;

#[allow(clippy::too_many_arguments)]
pub(crate) fn direct_weave(
    bc: &mut StatCoderContext,
    data_buffers: &mut DataBuffers,
    lon_idx: i32,
    lat_idx: i32,
    divisor: i32,
    way_validator: &mut dyn TagValueValidator,
    mut waypoint_matcher: Option<&mut dyn WaypointMatcher>,
    hollow_nodes: &mut OsmNodesMap,
) {
    let cellsize = 1_000_000 / divisor;
    let id64_base = (i64::from(lon_idx.wrapping_mul(cellsize)) << 32) | i64::from(lat_idx.wrapping_mul(cellsize));

    let way_tag_coder = TagValueCoder::new(bc, data_buffers, Some(&mut *way_validator));
    let node_tag_coder = TagValueCoder::new(bc, data_buffers, None);
    let node_idx_diff = NoisyDiffCoder::new(bc);
    let node_ele_diff = NoisyDiffCoder::new(bc);
    let ext_lon_diff = NoisyDiffCoder::new(bc);
    let ext_lat_diff = NoisyDiffCoder::new(bc);
    let trans_ele_diff = NoisyDiffCoder::new(bc);

    let size = bc.decode_noisy_number(5);

    let faid = &mut data_buffers.ibuf2;
    faid.clear();
    faid.resize(size as usize, 0);
    bc.decode_sorted_array(faid, 0, size, 29, 0);

    let mut nodes: Vec<NodeIdx> = Vec::with_capacity(size as usize);
    for &id32 in faid.iter() {
        let id = id64_base.wrapping_add(expand_id32(id32));
        let ilon = (id >> 32) as i32;
        let ilat = id as i32;
        let node = match hollow_nodes.get(ilon, ilat) {
            None => hollow_nodes.create_node(ilon, ilat),
            Some(node) => {
                hollow_nodes.node_mut(node).visit_id = 1;
                hollow_nodes.remove(node);
                node
            }
        };
        nodes.push(node);
    }

    let _netdatasize = bc.decode_noisy_number(10); // (not needed for direct weaving)
    let mut w = ByteDataWriter::new(std::mem::take(&mut data_buffers.bbuf1));

    let mut selev = 0i32;
    for n in 0..nodes.len() {
        let node = nodes[n];
        let (ilon, ilat) = (hollow_nodes.node(node).ilon, hollow_nodes.node(node).ilat);

        // future escapes (turn restrictions?)
        let mut tr_exceptions: i16 = 0;
        loop {
            let feature_id = bc.decode_var_bits();
            if feature_id == 0 {
                break;
            }
            let bitsize = bc.decode_noisy_number(5);

            if feature_id == 2 {
                // exceptions to turn-restriction
                tr_exceptions = bc.decode_bounded(1023) as i16;
            } else if feature_id == 1 {
                // turn-restriction
                let exceptions = tr_exceptions;
                tr_exceptions = 0;
                let is_positive = bc.decode_bit();
                let from_lon = ilon.wrapping_add(bc.decode_noisy_diff(10));
                let from_lat = ilat.wrapping_add(bc.decode_noisy_diff(10));
                let to_lon = ilon.wrapping_add(bc.decode_noisy_diff(10));
                let to_lat = ilat.wrapping_add(bc.decode_noisy_diff(10));
                hollow_nodes.add_turn_restriction(
                    node,
                    TurnRestriction::new(is_positive, exceptions, from_lon, from_lat, to_lon, to_lat),
                );
            } else {
                for _ in 0..bitsize {
                    bc.decode_bit(); // unknown feature, just skip
                }
            }
        }

        selev = selev.wrapping_add(node_ele_diff.decode_signed_value(bc));
        hollow_nodes.node_mut(node).selev = selev as i16;
        let node_tags = node_tag_coder.decode_tag_value_set(bc);
        hollow_nodes.node_mut(node).node_description = node_tags.map(|t| t.data.clone()); // TODO in Java: unified?

        let links = bc.decode_noisy_number(1);
        for _ in 0..links {
            let node_idx = (n as i32).wrapping_add(node_idx_diff.decode_signed_value(bc)) as usize;

            let dlon_remaining;
            let dlat_remaining;

            let mut is_reverse = false;
            if node_idx != n {
                // internal (forward-) link
                let target = hollow_nodes.node(nodes[node_idx]);
                dlon_remaining = target.ilon.wrapping_sub(ilon);
                dlat_remaining = target.ilat.wrapping_sub(ilat);
            } else {
                is_reverse = bc.decode_bit();
                dlon_remaining = ext_lon_diff.decode_signed_value(bc);
                dlat_remaining = ext_lat_diff.decode_signed_value(bc);
            }

            let way_tags = way_tag_coder.decode_tag_value_set(bc);

            let linklon = ilon.wrapping_add(dlon_remaining);
            let linklat = ilat.wrapping_add(dlat_remaining);
            w.aboffset = 0;
            if !is_reverse {
                // write geometry for forward links only
                decode_transfer_nodes(
                    bc,
                    &trans_ele_diff,
                    &mut w,
                    way_tags,
                    way_validator,
                    waypoint_matcher.as_deref_mut(),
                    (ilon, ilat),
                    (dlon_remaining, dlat_remaining),
                );
            }

            if let Some(tags) = way_tags {
                let geometry: Option<Rc<[u8]>> = (w.aboffset > 0).then(|| w.data()[..w.aboffset].into());

                if node_idx != n {
                    // valid internal (forward-) link
                    let node2 = nodes[node_idx];
                    let link = hollow_nodes.reusable_link(node, node2);
                    let l = hollow_nodes.link_mut(link);
                    l.description_bitmap = Some(tags.data.clone());
                    l.geometry = geometry;
                    hollow_nodes.add_link(node, link, is_reverse, node2);
                } else {
                    // weave external link
                    hollow_nodes.add_link_to(node, linklon, linklat, Some(tags.data.clone()), geometry, is_reverse);
                    hollow_nodes.node_mut(node).visit_id = 1;
                }
            }
        } // ... loop over links
    } // ... loop over nodes

    data_buffers.bbuf1 = w.into_data();
    hollow_nodes.cleanup_and_count(&nodes);
}

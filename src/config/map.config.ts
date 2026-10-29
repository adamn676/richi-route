export const MAP_LABELS_ANCHOR = 'map-labels-anchor';
export const SEGMENTS_SOURCE_ID = 'segments-source';
export const SEGMENTS_OUTLINE_LAYER = 'segments-outline';
export const SEGMENTS_ROUTE_LAYER = 'segments-routed';
export const SEGMENTS_ARRIVING_OUTLINE_LAYER = 'segments-arriving-outline';
export const SEGMENTS_ARRIVING_LAYER = 'segments-arriving';
export const SEGMENTS_AIR_LAYER = 'segments-air';
export const SEGMENTS_WAITING_LAYER = 'segments-waiting';
export const SEGMENTS_FORMER_SOURCE_ID = 'segments-former-source';
export const SEGMENTS_FORMER_OUTLINE_LAYER = 'segments-former-outline';
export const SEGMENTS_FORMER_LAYER = 'segments-former';
export const SEGMENTS_BASE_LAYER = 'segments-base';
export const LOOP_OUTLINE_LAYER = 'loop-suggestions-outline';
// The local map's coverage, its Europe extract: the map shows no more than that, so the world never repeats.
export const MAP_BOUNDS: [[number, number], [number, number]] = [[-25, 34], [45, 72]];
// The routing data's area (its 5° tiles E5–E15, N45): places beyond it cannot be routed to, so search keeps to it.
export const ROUTING_BOUNDS: [[number, number], [number, number]] = [[5, 45], [20, 50]];

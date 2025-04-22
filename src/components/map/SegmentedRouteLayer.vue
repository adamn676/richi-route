<!-- src/components/map/SegmentedRouteLayer.vue -->
<template>
  <div />
</template>

<script setup lang="ts">
import { watch } from "vue";
import type { FeatureCollection, Feature, LineString } from "geojson";
import maplibregl from "maplibre-gl";
import type { LayerSpecification } from "maplibre-gl";

import {
  SEGMENTS_SOURCE_ID,
  SEGMENTS_BASE_LAYER,
  SEGMENTS_HIGHLIGHT_LAYER,
  SEGMENTS_OUTLINE_LAYER,
  SEGMENTS_ARROWS_LAYER,
} from "@/config/map.config";

/**
 * Component props
 * @property {Object} map - The MapLibre map instance
 * @property {FeatureCollection|null} route - GeoJSON route data
 */
const props = defineProps<{
  map: maplibregl.Map;
  route: FeatureCollection | null;
}>();

// Configure the route styling here
const routeStyle = {
  // Main route line (brighter interior)
  baseColor: "#818cf8", // Indigo-400 (lighter/brighter indigo)
  baseWidth: 5,

  // Highlight effect when hovering
  highlightColor: "#c7d2fe", // Indigo-200 (even brighter for hover)
  highlightWidth: 6,

  // Outline/border effect (darker border)
  outlineColor: "#312e81", // Indigo-900 (very dark indigo)
  outlineWidth: 8,
  outlineOpacity: 0.9,

  // Direction arrows
  arrowColor: "#ffffff", // White arrows
};

/**
 * Breaks a multi‑coordinate LineString into single‑segment Features,
 * tagging each with its segment index. This allows hover/highlight
 * logic on a per‑segment basis.
 *
 * @param {FeatureCollection} fc - The route GeoJSON
 * @returns {Feature<LineString>[]} Array of individual line segments with idx props
 */
function getSegments(
  fc: FeatureCollection
): Feature<LineString, { idx: number }>[] {
  const coords = (fc.features[0].geometry as LineString).coordinates;
  return coords.slice(0, -1).map((start, i) => ({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [start, coords[i + 1]],
    },
    properties: { idx: i },
  }));
}

/**
 * Creates a LineString feature for arrow placement along the route
 */
function getRouteLineForArrows(fc: FeatureCollection): FeatureCollection {
  // Use the original LineString for symbol placement
  const coords = (fc.features[0].geometry as LineString).coordinates;

  // Create a new LineString with the route coordinates
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: coords,
        },
        properties: {},
      },
    ],
  };
}

/**
 * Loads your inline SVG arrow (from materialIcons.east) as a MapLibre image.
 * Registers it under the name "arrow-icon" on first call.
 */
function addArrowIcon(m: maplibregl.Map) {
  if (m.hasImage("arrow-icon")) return;

  // Use a custom arrow SVG that is already correctly oriented
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
      <path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z" fill="${routeStyle.arrowColor}"/>
    </svg>
  `.trim();

  const img = new Image();
  img.onload = () => m.addImage("arrow-icon", img);
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/**
 * Moves route layers below map text layers to prevent overlap
 * This ensures that important map labels remain visible
 *
 * @param {Object} m - The MapLibre map instance
 */
function moveLayersBelowLabels(m: maplibregl.Map): void {
  const layers = m.getStyle().layers as LayerSpecification[];
  const labelLayers = layers
    .filter((ly) => ly.id.includes("label") || ly.id.includes("text"))
    .map((ly) => ly.id);
  if (labelLayers.length) {
    const firstLabel = labelLayers[0];
    if (m.getLayer(SEGMENTS_OUTLINE_LAYER))
      m.moveLayer(SEGMENTS_OUTLINE_LAYER, firstLabel);
    if (m.getLayer(SEGMENTS_BASE_LAYER))
      m.moveLayer(SEGMENTS_BASE_LAYER, firstLabel);
    if (m.getLayer(SEGMENTS_HIGHLIGHT_LAYER))
      m.moveLayer(SEGMENTS_HIGHLIGHT_LAYER, firstLabel);
    if (m.getLayer(SEGMENTS_ARROWS_LAYER))
      m.moveLayer(SEGMENTS_ARROWS_LAYER, firstLabel);
  }
}

/**
 * (Re)draws the segment layers:
 * 1. Removes any old layers/source.
 * 2. Adds a GeoJSON source of individual segments.
 * 3. Adds multiple layers for visual effects: outline, base, highlight.
 * 4. Hooks up mouse events for hover highlighting.
 * 5. Ensures route layers don't overlap map text.
 * 6. Adds an arrow‐symbol layer to show direction.
 *
 * @param {Object} m - The MapLibre map instance
 * @param {FeatureCollection} route - The route GeoJSON data
 */
function draw(m: maplibregl.Map, route: FeatureCollection) {
  // 1. teardown any previous segment layers/source
  if (m.getLayer(SEGMENTS_HIGHLIGHT_LAYER))
    m.removeLayer(SEGMENTS_HIGHLIGHT_LAYER);
  if (m.getLayer(SEGMENTS_BASE_LAYER)) m.removeLayer(SEGMENTS_BASE_LAYER);
  if (m.getLayer(SEGMENTS_OUTLINE_LAYER)) m.removeLayer(SEGMENTS_OUTLINE_LAYER);
  if (m.getSource(SEGMENTS_SOURCE_ID)) m.removeSource(SEGMENTS_SOURCE_ID);
  if (m.getLayer(SEGMENTS_ARROWS_LAYER)) m.removeLayer(SEGMENTS_ARROWS_LAYER);
  if (m.getSource(SEGMENTS_ARROWS_LAYER)) m.removeSource(SEGMENTS_ARROWS_LAYER);

  // 2. build a FeatureCollection of 1‑segment features
  const segments = getSegments(route);
  const geojson = { type: "FeatureCollection", features: segments };

  // 3. add source + outline/base/highlight layers
  m.addSource(SEGMENTS_SOURCE_ID, { type: "geojson", data: geojson } as any);

  // Outline
  m.addLayer({
    id: SEGMENTS_OUTLINE_LAYER,
    type: "line",
    source: SEGMENTS_SOURCE_ID,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": routeStyle.outlineColor,
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        4,
        13,
        6,
        16,
        9,
        19,
        12,
      ],
      "line-blur": 0.5,
      "line-opacity": routeStyle.outlineOpacity,
    },
  });

  // Base
  m.addLayer({
    id: SEGMENTS_BASE_LAYER,
    type: "line",
    source: SEGMENTS_SOURCE_ID,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": routeStyle.baseColor,
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        2,
        13,
        3.5,
        16,
        5,
        19,
        8,
      ],
    },
  });

  // Highlight (on hover)
  m.addLayer({
    id: SEGMENTS_HIGHLIGHT_LAYER,
    type: "line",
    source: SEGMENTS_SOURCE_ID,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": routeStyle.highlightColor,
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        3,
        13,
        5,
        16,
        7,
        19,
        10,
      ],
      "line-opacity": [
        "interpolate",
        ["linear"],
        ["get", "idx"],
        -1,
        0,
        0,
        0.9,
      ],
    },
    filter: ["==", "idx", -1],
  });

  // 4. hover behavior
  m.on("mousemove", SEGMENTS_BASE_LAYER, (e: any) => {
    const f = e.features?.[0] as Feature<LineString, { idx: number }>;
    const idx = f?.properties.idx ?? -1;
    m.setFilter(SEGMENTS_HIGHLIGHT_LAYER, ["==", "idx", idx]);
    m.getCanvas().style.cursor = "pointer";
  });
  m.on("mouseleave", SEGMENTS_BASE_LAYER, () => {
    m.setFilter(SEGMENTS_HIGHLIGHT_LAYER, ["==", "idx", -1]);
    m.getCanvas().style.cursor = "";
  });

  // 5. keep below text
  moveLayersBelowLabels(m);

  // 6. Add direction‐arrow symbol layer
  addArrowIcon(m);

  // Prepare arrow GeoJSON - use full route LineString for symbol placement
  const arrowsGeojson = getRouteLineForArrows(route);

  // Source + symbol layer
  m.addSource(SEGMENTS_ARROWS_LAYER, {
    type: "geojson",
    data: arrowsGeojson,
  });

  m.addLayer({
    id: SEGMENTS_ARROWS_LAYER,
    type: "symbol",
    source: SEGMENTS_ARROWS_LAYER,
    layout: {
      "icon-image": "arrow-icon",
      // Even smaller arrows
      "icon-size": [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        0.3, // Tiny at low zoom
        14,
        0.35, // Slightly larger at middle zoom
        18,
        0.45, // Moderate at high zoom
      ],
      // No rotation - rely on symbol-placement: line to align the icons
      "icon-rotate": 0,
      "icon-rotation-alignment": "map",
      // Place symbols along the line with controlled spacing
      "symbol-placement": "line",
      "symbol-spacing": [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        120, // Wider spacing at low zoom
        14,
        180, // Medium spacing at middle zoom
        18,
        240, // Even wider at high zoom
      ],
      // Prevent icons from overlapping with other map elements
      "icon-allow-overlap": false,
      "icon-ignore-placement": false,
    },
  });
}

// Watch for changes to the route prop
watch(
  () => props.route,
  (route) => {
    const m = props.map;
    if (!m || !route) return;
    // If style isn't ready, defer until load
    if (!m.isStyleLoaded?.()) {
      m.once("load", () => draw(m, route));
    } else {
      draw(m, route);
    }
  },
  { immediate: true }
);
</script>

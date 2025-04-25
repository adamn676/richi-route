// src/composables/useSegmentedRoute.ts
import maplibregl from "maplibre-gl";
import type { LayerSpecification } from "maplibre-gl";
import type { FeatureCollection } from "geojson";

import {
  SEGMENTS_SOURCE_ID,
  SEGMENTS_OUTLINE_LAYER,
  SEGMENTS_BASE_LAYER,
  SEGMENTS_HIGHLIGHT_LAYER,
  SEGMENTS_ARROWS_LAYER,
} from "@/config/map.config";
import { routeStyle } from "@/config/mapStyle"; // Must be plain, non-reactive
import { getSegments, getRouteLineForArrows } from "@/utils/geometry";

/**
 * Add an arrow icon if not already present.
 * Ensure routeStyle.arrowColor is a plain string like "#000" or "rgb(255,0,0)".
 */
function addArrowIcon(map: maplibregl.Map) {
  if (map.hasImage("double-arrow-icon")) return;

  // Use a literal string for 'fill' to avoid reactivity issues
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
      <path
        d="M3.97498 19.725L9.47498 12L3.97498 4.25H8.17498L13.65 12L8.17498 19.725H3.97498ZM11.425 19.725L16.925 12L11.425 4.25H15.6L21.1 12L15.6 19.725H11.425Z"
        fill="${routeStyle.arrowColor}"     
        stroke="#000"                      
        stroke-width="0"                    
        stroke-linejoin="round"
        stroke-linecap="round"
      />
    </svg>
  `.trim();

  const image = new Image();
  image.onload = () => {
    map.addImage("double-arrow-icon", image);
  };
  image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/**
 * Move route layers beneath label layers
 */
function moveLayersBelowLabels(map: maplibregl.Map) {
  const styleLayers = map.getStyle().layers as LayerSpecification[];
  // Filter label or text layers
  const labelLayers = styleLayers
    .filter((ly) => ly.id.includes("label") || ly.id.includes("text"))
    .map((ly) => ly.id);

  if (labelLayers.length) {
    const firstLabel = labelLayers[0];
    [
      SEGMENTS_OUTLINE_LAYER,
      SEGMENTS_BASE_LAYER,
      SEGMENTS_HIGHLIGHT_LAYER,
      SEGMENTS_ARROWS_LAYER,
    ].forEach((layerId) => {
      if (map.getLayer(layerId)) {
        map.moveLayer(layerId, firstLabel);
      }
    });
  }
}

/**
 * Main composable function that returns a `renderSegments` method
 * for drawing your route segments with highlight & arrow layers.
 */
export function useSegmentedRoute() {
  function renderSegments(map: maplibregl.Map, route: FeatureCollection) {
    // 1) Teardown old layers & sources if they exist
    [
      SEGMENTS_HIGHLIGHT_LAYER,
      SEGMENTS_BASE_LAYER,
      SEGMENTS_OUTLINE_LAYER,
    ].forEach((ly) => {
      if (map.getLayer(ly)) map.removeLayer(ly);
    });
    if (map.getSource(SEGMENTS_SOURCE_ID)) {
      map.removeSource(SEGMENTS_SOURCE_ID);
    }

    if (map.getLayer(SEGMENTS_ARROWS_LAYER)) {
      map.removeLayer(SEGMENTS_ARROWS_LAYER);
    }
    if (map.getSource(SEGMENTS_ARROWS_LAYER)) {
      map.removeSource(SEGMENTS_ARROWS_LAYER);
    }

    // 2) Build segment data
    const segments = getSegments(route);
    const segmentGeoJSON: FeatureCollection = {
      type: "FeatureCollection",
      features: segments,
    };

    // 3) Add base route source
    map.addSource(SEGMENTS_SOURCE_ID, {
      type: "geojson",
      data: segmentGeoJSON,
    });

    // 4) Outline layer
    map.addLayer({
      id: SEGMENTS_OUTLINE_LAYER,
      type: "line",
      source: SEGMENTS_SOURCE_ID,
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": routeStyle.outlineColor, // Must be a plain string e.g. "#312e81"
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
        "line-opacity": routeStyle.outlineOpacity, // e.g. 0.9
      },
    });

    // 5) Base layer
    map.addLayer({
      id: SEGMENTS_BASE_LAYER,
      type: "line",
      source: SEGMENTS_SOURCE_ID,
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": routeStyle.baseColor, // e.g. "#818cf8"
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

    // 6) Highlight layer
    map.addLayer({
      id: SEGMENTS_HIGHLIGHT_LAYER,
      type: "line",
      source: SEGMENTS_SOURCE_ID,
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": routeStyle.highlightColor, // e.g. "#c7d2fe"
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
        // We'll show/hide it based on 'idx'
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

    // 7) Hover logic for highlight
    map.on("mousemove", SEGMENTS_BASE_LAYER, (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      let idx = -1;
      if (typeof feature.properties?.idx === "number") {
        idx = feature.properties.idx;
      }
      map.setFilter(SEGMENTS_HIGHLIGHT_LAYER, ["==", "idx", idx]);
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", SEGMENTS_BASE_LAYER, () => {
      map.setFilter(SEGMENTS_HIGHLIGHT_LAYER, ["==", "idx", -1]);
      map.getCanvas().style.cursor = "";
    });

    // 8) Move below labels
    moveLayersBelowLabels(map);

    // 9) Add arrow icon & arrow layer
    addArrowIcon(map);

    const arrowGeoJSON = getRouteLineForArrows(route);
    map.addSource(SEGMENTS_ARROWS_LAYER, {
      type: "geojson",
      data: arrowGeoJSON,
    });
    map.addLayer({
      id: SEGMENTS_ARROWS_LAYER,
      type: "symbol",
      source: SEGMENTS_ARROWS_LAYER,
      layout: {
        "icon-image": "double-arrow-icon",
        "icon-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          10,
          0.3,
          14,
          0.35,
          18,
          0.45,
        ],
        "symbol-placement": "line",
        "symbol-spacing": [
          "interpolate",
          ["linear"],
          ["zoom"],
          10,
          120,
          14,
          180,
          18,
          240,
        ],
        "icon-allow-overlap": false,
        "icon-ignore-placement": false,
      },
    });
  }

  return {
    renderSegments,
  };
}

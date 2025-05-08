// import { defineStore } from "pinia";
// import type { FeatureCollection } from "geojson";
// import { getRoute } from "@/services/route.service";
// import {
//   reverseGeocode,
//   type Place,
// } from "@/services/maptiler.service";

// export type Coord = [number, number];

// interface ShapePoint {
//   idx: number; // index in the backbone coords
//   coord: Coord; // the drag‑to‑shape coordinate
// }

// interface Waypoint {
//   coords: Coord;
//   address: string | null;
//   isGeocoding: boolean;
//   kind: string;
// }

// export const useRouteStore = defineStore("route", {
//   state: () => ({
//     // Hard stops (start → via… → end)
//     waypoints: [
//       {
//         coords: [0, 0],
//         address: "",
//         isGeocoding: false,
//         kind: "start",
//       },
//       {
//         coords: [0, 0],
//         address: "",
//         isGeocoding: false,
//         kind: "end",
//       },
//     ] as Waypoint[],

//     // Human‑readable labels for each waypoint
//     // addresses: [] as (string | null)[],

//     // Loading flags for reverse geocoding
//     // isGeocoding: [] as boolean[],

//     // Soft shaping tweaks
//     shapingPoints: [] as ShapePoint[],

//     // Place kinds for each waypoint (poi, address, road, etc.)
//     // kinds: [] as string[],

//     // The resulting GeoJSON route
//     route: null as FeatureCollection | null,
//   }),

//   actions: {
//     /** ORS call over hard stops only */
//     async calculateHardRoute() {
//       if (this.waypoints.length < 2) return;

//       // Check if Start or End is still [0,0]
//       const start = this.waypoints[0].coords;
//       const end = this.waypoints[1].coords;

//       // If either is [0,0], skip calling ORS
//       if (
//         (start[0] === 0 && start[1] === 0) ||
//         (end[0] === 0 && end[1] === 0)
//       ) {
//         console.log("Skipping route calc — placeholders still at [0,0].");
//         return;
//       }
//       const coords = this.waypoints.map(
//         (wp) => [wp.coords[0], wp.coords[1]] as [number, number]
//       );
//       console.log("calculateHardRoute - coords to ORS:", coords);
//       const data = await getRoute(coords);
//       this.route = orsToFeatureCollection(data);
//       console.log("calculateHardRoute - ORS result:", this.route);
//     },

//     /** Splice in each shaping point */
//     async applyShaping() {
//       if (!this.route) return;

//       // special-case: exactly start/end + shaping -> one global ORS call
//       if (this.waypoints.length === 2 && this.shapingPoints.length) {
//         // single global call
//         const coords = [
//           this.waypoints[0].coords,
//           ...this.shapingPoints.map((p) => p.coord),
//           this.waypoints[1].coords,
//         ];
//         const data = await getRoute(coords);
//         this.route = orsToFeatureCollection(data);
//         return;
//       }

//       // partial splicing
//       const original = (this.route.features[0].geometry as GeoJSON.LineString)
//         .coordinates as Coord[];
//       let merged = [...original];

//       for (const { idx, coord } of this.shapingPoints) {
//         if (idx < 0 || idx + 1 >= original.length) continue;
//         const startCoord = original[idx];
//         const endCoord = original[idx + 1];
//         console.log("applyShaping - partial coords:", [
//           startCoord,
//           coord,
//           endCoord,
//         ]);
//         const localData = await getRoute([startCoord, coord, endCoord]);
//         console.log("applyShaping - localData:", localData);
//         const localFC = orsToFeatureCollection(localData);
//         const localCoords = (localFC.features[0].geometry as GeoJSON.LineString)
//           .coordinates as Coord[];
//         merged.splice(idx, 2, ...localCoords);
//       }

//       this.route = {
//         type: "FeatureCollection",
//         features: [
//           {
//             type: "Feature",
//             geometry: { type: "LineString", coordinates: merged },
//             properties: {},
//           },
//         ],
//       };
//     },

//     /** Master recalculation: backbone + shaping */
//     async recalc() {
//       await this.calculateHardRoute();
//       if (this.shapingPoints.length) {
//         await this.applyShaping();
//       }
//     },

//     /** Reverse‑geocode a single waypoint index */
//     async geocodeWaypoint(index: number) {
//       // Access the single waypoint object
//       const wp = this.waypoints[index];
//       if (!wp) return;
//       wp.isGeocoding = true;

//       try {
//         const place = await reverseGeocode(wp.coords);
//         wp.address = place?.label ?? null;
//         wp.kind = place?.kind ?? "";
//       } catch (err) {
//         wp.address = "Lookup failed";
//         wp.kind = "";
//       } finally {
//         wp.isGeocoding = false;
//       }
//     },

//     async addWaypoint(coord: Coord) {
//       // create a single object for the new waypoint
//       const wp: Waypoint = {
//         coords: coord,
//         address: null,
//         isGeocoding: false,
//         kind: "address", // or whatever default you want
//       };
//       this.waypoints.push(wp);

//       // Recalc route
//       await this.recalc();

//       // Geocode the new waypoint
//       await this.geocodeWaypoint(this.waypoints.length - 1);
//     },

//     async addPlace(place: Place) {
//       const wp: Waypoint = {
//         coords: place.coord,
//         address: place.label,
//         isGeocoding: false,
//         kind: place.kind || "poi",
//       };
//       this.waypoints.push(wp);

//       await this.recalc();
//       // We already have an address & kind from place, so no extra geocode needed
//     },

//     async insertWaypoint(i: number, coord: Coord) {
//       const wp: Waypoint = {
//         coords: coord,
//         address: null,
//         isGeocoding: false,
//         kind: "address",
//       };
//       this.waypoints.splice(i, 0, wp);

//       await this.recalc();
//       await this.geocodeWaypoint(i);
//     },

//     /** Add a soft shaping point + recalc */
//     async insertShapingPoint(idx: number, coord: Coord) {
//       this.shapingPoints.splice(idx, 0, { idx, coord });
//       await this.recalc();
//     },

//     /**
//      * Insert a new empty waypoint just before the last one (End).
//      * That effectively creates a "via" stop.
//      */
//     async insertIntermediateStop() {
//       // If we have < 2 waypoints, we can't properly add a stop between them
//       if (this.waypoints.length < 2) {
//         console.warn("Not enough waypoints to insert an intermediate stop");
//         return;
//       }

//       // We'll insert it right before the last one
//       const insertIndex = this.waypoints.length - 1;

//       // Create a new blank waypoint
//       const wp: Waypoint = {
//         coords: [0, 0], // default coords
//         address: null,
//         isGeocoding: false,
//         kind: "address", // or 'via'
//       };

//       // Insert into the array
//       this.waypoints.splice(insertIndex, 0, wp);

//       // Recalc route if needed
//       await this.recalc();
//     },

//     async updateWaypoint(index: number, newCoords: Coord) {
//       if (!this.waypoints[index]) return;
//       this.waypoints[index].coords = newCoords;
//       await this.recalc();
//       await this.geocodeWaypoint(index);
//     },

//     async removeWaypoint(i: number) {
//       this.waypoints.splice(i, 1);
//       // Clear shaping so we don't have index mismatch
//       this.shapingPoints = [];

//       await this.recalc();
//     },

//     /** Clear all shaping tweaks + recalc */
//     async clearShaping() {
//       this.shapingPoints = [];
//       await this.recalc();
//     },
//   },
// });

// function orsToFeatureCollection(orsData: any): FeatureCollection {
//   // If data is already a FeatureCollection with features array
//   if (orsData && orsData.type === "FeatureCollection" && orsData.features) {
//     return orsData as FeatureCollection;
//   }

//   // Original ORS structure handling - may be needed for different API versions
//   if (orsData && orsData.routes && orsData.routes[0]) {
//     // Extract the line geometry from the first route
//     const lineGeom = orsData.routes[0].geometry;

//     // Wrap it in a standard FeatureCollection
//     return {
//       type: "FeatureCollection",
//       features: [
//         {
//           type: "Feature",
//           geometry: lineGeom,
//           properties: {},
//         },
//       ],
//     } as FeatureCollection;
//   }

//   // Default empty response
//   return {
//     type: "FeatureCollection",
//     features: [],
//   } as FeatureCollection;
// }

// export type RouteStore = ReturnType<typeof useRouteStore>;

// src/stores/route.store.ts
import { defineStore } from "pinia";
import type { FeatureCollection, GeoJsonProperties, Geometry } from "geojson"; // Added more specific GeoJSON types
import { getRoute } from "@/services/route.service";
import {
  reverseGeocode,
  type Place,
  forwardGeocode,
} from "@/services/maptiler.service";

export type Coord = [number, number];

export interface ShapePoint {
  // Made exportable if needed elsewhere
  idx: number;
  coord: Coord;
}

export interface Waypoint {
  id: string;
  coords: Coord;
  address: string | null;
  isGeocoding: boolean;
  kind: string;
  userInput?: string; // Keeping it optional as per current definition, AddressSearchInput handles undefined modelValue
}

let waypointIdCounter = 0; // Consider module-level scope carefully for HMR during dev
const newWaypointId = () => `wp-${waypointIdCounter++}`;

export const useRouteStore = defineStore("route", {
  state: () => ({
    waypoints: [
      {
        id: newWaypointId(),
        coords: [0, 0] as Coord,
        address: "Start Point",
        isGeocoding: false,
        kind: "start",
        userInput: "", // Initialize userInput
      },
      {
        id: newWaypointId(),
        coords: [0, 0] as Coord,
        address: "End Point",
        isGeocoding: false,
        kind: "end",
        userInput: "", // Initialize userInput
      },
    ] as Waypoint[],
    shapingPoints: [] as ShapePoint[],
    route: null as FeatureCollection | null,
    isCalculatingGlobalRoute: false,
  }),

  actions: {
    // ... (all your existing actions like calculateHardRoute, applyShaping, recalc, geocodeWaypoint, etc.)
    // Ensure they are all present here from your working file. I'll add the missing/modified ones.

    // HELPER (ensure it's within actions or callable if it modifies `this` or state)
    // If it's purely a factory, it can be outside, but if it uses `this`, it needs to be an action or have `this` bound.
    // For simplicity, making it a private-like action.
    _addWaypointInternal(
      coord: Coord,
      kind: string,
      address: string | null = null,
      userInputInitialValue: string = ""
    ): Waypoint {
      const newId = newWaypointId();
      const defaultAddressText =
        kind === "start"
          ? "Start Point"
          : kind === "end"
          ? "End Point"
          : "Via Point";
      const finalAddress = address ?? defaultAddressText;
      // Initialize userInput based on address unless explicitly provided otherwise
      const finalUserInput = userInputInitialValue || finalAddress || "";
      return {
        id: newId,
        coords: coord,
        address: finalAddress,
        isGeocoding: false,
        kind: kind,
        userInput: finalUserInput, // Initialize userInput properly
      };
    },

    async addIntermediateStopAndPrepare() {
      const newWp = this._addWaypointInternal(
        [0, 0],
        "via",
        "New Via Point (Search or click map)",
        ""
      ); // userInput is empty
      const endIndex = this.waypoints.findIndex((wp) => wp.kind === "end");
      if (endIndex !== -1) {
        this.waypoints.splice(endIndex, 0, newWp);
      } else {
        this.waypoints.push(newWp);
      }
    },

    // Actions from user typing/selection - These SHOULD update userInput
    async searchAndSetWaypointAddress(waypointId: string, query: string) {
      const waypoint = this.waypoints.find((wp) => wp.id === waypointId);
      if (!waypoint) return;

      waypoint.isGeocoding = true;
      waypoint.userInput = query; // User's query is the current input value
      waypoint.address = `Searching for "${query}"...`;

      try {
        const places = await forwardGeocode(query);
        if (places.length > 0) {
          const firstPlace = places[0];
          waypoint.coords = firstPlace.coord;
          waypoint.address = firstPlace.label; // Set official address
          waypoint.userInput = firstPlace.label; // Set input value to official address
          waypoint.kind = firstPlace.kind || waypoint.kind;
          await this.recalc();
        } else {
          waypoint.address = "Location not found"; // Keep userInput as query
        }
      } catch (error) {
        console.error("Forward geocode error in store:", error);
        waypoint.address = "Search failed"; // Keep userInput as query
      } finally {
        waypoint.isGeocoding = false;
      }
    },

    // ... (ALL OTHER ACTIONS from your file: calculateHardRoute, applyShaping, geocodeWaypoint, addWaypointByClick, etc.)
    // Ensure all the actions you had in the file you pasted are still here.
    // The example from your paste:
    async calculateHardRoute(forceGlobalOptimize = false) {
      if (this.waypoints.length < 2) {
        this.route = null;
        return;
      }
      const validWaypoints = this.waypoints.filter(
        (wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0
      );
      if (validWaypoints.length < 2) {
        this.route = null;
        console.log("Skipping route calc — not enough valid waypoints.");
        return;
      }
      const coords = validWaypoints.map(
        (wp) => [wp.coords[0], wp.coords[1]] as [number, number]
      );
      console.log("calculateHardRoute - coords to ORS:", coords);
      try {
        const data = await getRoute(coords);
        this.route = orsToFeatureCollection(data);
        console.log("calculateHardRoute - ORS result:", this.route);
      } catch (error) {
        console.error("Error calculating hard route:", error);
        this.route = null;
      }
    },

    async applyShaping() {
      if (!this.route || this.waypoints.length < 2) return;
      if (this.waypoints.length === 2 && this.shapingPoints.length) {
        const validWaypoints = this.waypoints.filter(
          (wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0
        );
        if (validWaypoints.length < 2) return;
        const coords = [
          validWaypoints[0].coords,
          ...this.shapingPoints.map((p) => p.coord),
          validWaypoints[1].coords,
        ];
        try {
          const data = await getRoute(coords);
          this.route = orsToFeatureCollection(data);
        } catch (error) {
          console.error("Error applying shaping (global):", error);
        }
        return;
      }
      if (
        this.shapingPoints.length > 0 &&
        this.route?.features?.[0]?.geometry?.type === "LineString"
      ) {
        const coordsForORS: Coord[] = [];
        const validHardPoints = this.waypoints.filter(
          (wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0
        );
        if (validHardPoints.length >= 2) {
          coordsForORS.push(validHardPoints[0].coords);
          this.shapingPoints.sort((a, b) => a.idx - b.idx);
          for (const sp of this.shapingPoints) {
            coordsForORS.push(sp.coord);
          }
          if (validHardPoints.length > 1) {
            // Ensure there's an end point
            coordsForORS.push(
              validHardPoints[validHardPoints.length - 1].coords
            );
          }
          // This simplified logic for >2 hard points needs to be robust
          // It currently takes first hard point, all shaping points, last hard point.
          // Intermediate hard points are ignored by this specific shaping logic if shaping points exist.
          // The `calculateHardRoute` would have already calculated with intermediate points.
          // This section might need to be more about *local splicing* into the result of `calculateHardRoute`.
          // For now, it recalculates a segment from first to last valid hardpoint including shaping points.

          console.log(
            "applyShaping - coords to ORS (complex case):",
            coordsForORS
          );
          try {
            const data = await getRoute(coordsForORS);
            this.route = orsToFeatureCollection(data);
          } catch (error) {
            console.error("Error applying shaping (complex case):", error);
          }
        }
      }
    },
    async recalc(options: { forceGlobalOptimize?: boolean } = {}) {
      if (options.forceGlobalOptimize) {
        this.isCalculatingGlobalRoute = true;
        this.shapingPoints = [];
        await this.calculateHardRoute(true);
        this.isCalculatingGlobalRoute = false;
      } else {
        await this.calculateHardRoute();
        if (this.shapingPoints.length > 0 && this.route) {
          await this.applyShaping();
        }
      }
    },

    async geocodeWaypoint(waypointId: string) {
      const waypoint = this.waypoints.find((wp) => wp.id === waypointId);
      if (!waypoint) return;
      if (
        waypoint.coords[0] === 0 &&
        waypoint.coords[1] === 0 &&
        (waypoint.address === "Start Point" ||
          waypoint.address === "End Point" ||
          waypoint.address === "Via Point")
      ) {
        waypoint.isGeocoding = false;
        return;
      }

      waypoint.isGeocoding = true;
      const previousAddress = waypoint.address;
      waypoint.address = "Loading address...";
      // Keep userInput as is while loading? Or clear? Let's clear for now.
      // waypoint.userInput = "Loading..."; // Or maybe not change userInput yet

      try {
        const place = await reverseGeocode(waypoint.coords);
        const newAddress = place?.label ?? "Address not found";
        waypoint.address = newAddress; // Update official address
        waypoint.userInput = newAddress; // <<<< UPDATE userInput too for consistency
        waypoint.kind = place?.kind || waypoint.kind;
      } catch (err) {
        console.error("Geocode waypoint error:", err);
        waypoint.address = "Address lookup failed"; // Revert or show error
        // Don't update userInput on failure, keep previous value or clear?
        // Let's keep previous userInput on failure for now.
      } finally {
        waypoint.isGeocoding = false;
      }
    },

    async addWaypointByClick(coord: Coord) {
      const startWp = this.waypoints.find((wp) => wp.kind === "start");
      const endWp = this.waypoints.find((wp) => wp.kind === "end");
      let waypointToUpdate: Waypoint | undefined;

      if (startWp && startWp.coords[0] === 0 && startWp.coords[1] === 0) {
        startWp.coords = coord;
        startWp.userInput = "Loading address..."; // Set userInput temporarily
        waypointToUpdate = startWp;
      } else if (endWp && endWp.coords[0] === 0 && endWp.coords[1] === 0) {
        endWp.coords = coord;
        endWp.userInput = "Loading address..."; // Set userInput temporarily
        waypointToUpdate = endWp;
      } else {
        const newWp = this._addWaypointInternal(
          coord,
          "via",
          "Loading address...",
          "Loading address..."
        );
        const endIndex = this.waypoints.findIndex((wp) => wp.kind === "end");
        if (endIndex !== -1) {
          this.waypoints.splice(endIndex, 0, newWp);
        } else {
          this.waypoints.push(newWp);
        }
        waypointToUpdate = newWp;
      }

      await this.recalc();
      if (waypointToUpdate) {
        // geocodeWaypoint will update both address and userInput
        await this.geocodeWaypoint(waypointToUpdate.id);
      }
    },

    async addPlaceAsWaypoint(place: Place) {
      // Called when user selects from AddressSearchInput
      const startWp = this.waypoints.find((wp) => wp.kind === "start");
      const endWp = this.waypoints.find((wp) => wp.kind === "end");

      const newWpData = {
        coords: place.coord,
        address: place.label,
        isGeocoding: false,
        kind: place.kind || "poi",
        userInput: place.label, // << Set userInput to the selected place's label
      };

      if (
        startWp &&
        startWp.coords[0] === 0 &&
        startWp.coords[1] === 0 &&
        startWp.address === "Start Point"
      ) {
        Object.assign(startWp, { ...newWpData, kind: "start" });
      } else if (
        endWp &&
        endWp.coords[0] === 0 &&
        endWp.coords[1] === 0 &&
        endWp.address === "End Point"
      ) {
        Object.assign(endWp, { ...newWpData, kind: "end" });
      } else {
        const createdWp = this._addWaypointInternal(
          place.coord,
          place.kind || "poi",
          place.label,
          place.label
        );
        const endIndex = this.waypoints.findIndex((w) => w.kind === "end");
        if (endIndex !== -1) {
          this.waypoints.splice(endIndex, 0, createdWp);
        } else {
          this.waypoints.push(createdWp);
        }
      }
      await this.recalc();
    },

    async insertWaypointOnRoute(indexAfter: number, coord: Coord) {
      const newWp = this._addWaypointInternal(coord, "via", null, "");
      this.waypoints.splice(indexAfter, 0, newWp);
      await this.recalc();
      await this.geocodeWaypoint(newWp.id);
    },
    async insertShapingPoint(idx: number, coord: Coord) {
      this.shapingPoints.push({ idx, coord });
      this.shapingPoints.sort((a, b) => a.idx - b.idx);
      await this.recalc();
    },

    async updateWaypointCoord(waypointId: string, newCoords: Coord) {
      const waypoint = this.waypoints.find((wp) => wp.id === waypointId);
      if (!waypoint) return;

      waypoint.coords = newCoords;
      waypoint.userInput = "Loading address..."; // Set userInput temporarily
      this.shapingPoints = [];
      await this.recalc();
      // geocodeWaypoint will update both address and userInput
      await this.geocodeWaypoint(waypointId);
    },

    async removeWaypoint(waypointId: string) {
      const index = this.waypoints.findIndex((wp) => wp.id === waypointId);
      if (index === -1) return;
      const waypoint = this.waypoints[index];
      const isStart = waypoint.kind === "start";
      const isEnd = waypoint.kind === "end";

      if ((isStart || isEnd) && this.waypoints.length > 1) {
        // If it's a main point and others exist
        waypoint.coords = [0, 0];
        waypoint.address = isStart ? "Start Point" : "End Point";
        waypoint.userInput = waypoint.address;
        waypoint.isGeocoding = false;
      } else if (this.waypoints.length > 2 || (!isStart && !isEnd)) {
        this.waypoints.splice(index, 1);
      } else {
        // Last 1 or 2 points, reset instead of removing
        waypoint.coords = [0, 0];
        waypoint.address = isStart ? "Start Point" : "End Point";
        waypoint.userInput = waypoint.address;
        waypoint.isGeocoding = false;
      }
      this.shapingPoints = [];
      await this.recalc();
    },
    async clearShaping() {
      this.shapingPoints = [];
      await this.recalc();
    },
    async optimizeEntireRoute() {
      this.isCalculatingGlobalRoute = true;
      this.shapingPoints = [];
      await this.recalc({ forceGlobalOptimize: true });
      this.isCalculatingGlobalRoute = false;
    },
  }, // End of actions
});

// Ensure orsToFeatureCollection is correctly defined and used
function orsToFeatureCollection(orsData: any): FeatureCollection {
  if (orsData && orsData.type === "FeatureCollection" && orsData.features) {
    return orsData as FeatureCollection;
  }
  if (orsData?.routes?.[0]?.geometry) {
    // Simplified check
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: orsData.routes[0].geometry,
          properties: orsData.routes[0].summary || {},
        },
      ],
    } as FeatureCollection;
  }
  console.warn("ORS data is not in expected format", orsData);
  return { type: "FeatureCollection", features: [] };
}

export type RouteStore = ReturnType<typeof useRouteStore>;

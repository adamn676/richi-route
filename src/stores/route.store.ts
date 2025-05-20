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
import { defineStore } from 'pinia';
import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';
import { getRoute } from '@/services/route.service';
import { reverseGeocode, type Place, forwardGeocode } from '@/services/maptiler.service';

export type Coord = [number, number];

let waypointIdCounter = 0;
const newWaypointId = () => `wp-${waypointIdCounter++}`;

let shapePointIdCounter = 0;
const newShapePointId = () => `sp-${shapePointIdCounter++}`;

export interface ShapePoint {
  id: string;
  idx: number;
  coord: Coord;
}

export interface Waypoint {
  id: string;
  coords: Coord;
  address: string | null;
  isGeocoding: boolean;
  kind: string;
  userInput?: string;
}

export const useRouteStore = defineStore('route', {
  state: () => ({
    waypoints: [
      {
        id: newWaypointId(),
        coords: [0, 0] as Coord,
        address: 'Start Point',
        isGeocoding: false,
        kind: 'start',
        userInput: '',
      },
      {
        id: newWaypointId(),
        coords: [0, 0] as Coord,
        address: 'End Point',
        isGeocoding: false,
        kind: 'end',
        userInput: '',
      },
    ] as Waypoint[],
    shapingPoints: [] as ShapePoint[],
    route: null as FeatureCollection | null,
    isCalculatingGlobalRoute: false,
  }),

  actions: {
    _addWaypointInternal(coord: Coord, kind: string, address: string | null = null, userInputInitialValue: string = ''): Waypoint {
      const newId = newWaypointId();
      const defaultAddressText = kind === 'start' ? 'Start Point' : kind === 'end' ? 'End Point' : 'Via Point';
      const finalAddress = address ?? defaultAddressText;
      const finalUserInput = userInputInitialValue || finalAddress || '';
      return {
        id: newId,
        coords: coord,
        address: finalAddress,
        isGeocoding: false,
        kind: kind,
        userInput: finalUserInput,
      };
    },

    async addIntermediateStopAndPrepare() {
      // console.log('--- [RouteStore] addIntermediateStopAndPrepare CALLED ---');
      const newWp = this._addWaypointInternal([0, 0], 'via', 'New Via Point (Search or click map)', '');
      const endIndex = this.waypoints.findIndex((wp) => wp.kind === 'end');
      if (endIndex !== -1) {
        this.waypoints.splice(endIndex, 0, newWp);
      } else {
        this.waypoints.push(newWp);
      }
      // Watcher in useRouteCalculation.ts will trigger recalc
      console.log('--- [RouteStore] addIntermediateStopAndPrepare FINISHED ---');
    },

    async searchAndSetWaypointAddress(waypointId: string, query: string) {
      console.log(`--- [RouteStore] searchAndSetWaypointAddress CALLED - ID: ${waypointId}, Query: ${query} ---`);
      const waypoint = this.waypoints.find((wp) => wp.id === waypointId);
      if (!waypoint) {
        // console.warn('[RouteStore] searchAndSetWaypointAddress: Waypoint not found for ID:', waypointId);
        return;
      }

      waypoint.isGeocoding = true;
      waypoint.userInput = query;
      waypoint.address = `Searching for "${query}"...`;

      try {
        const places = await forwardGeocode(query);
        console.log('[RouteStore] searchAndSetWaypointAddress - Geocode results:', places);
        if (places.length > 0) {
          const firstPlace = places[0];
          waypoint.coords = firstPlace.coord;
          waypoint.address = firstPlace.label;
          waypoint.userInput = firstPlace.label;
          waypoint.kind = firstPlace.kind || waypoint.kind;
          // await this.recalc(); // REMOVED - Watcher in useRouteCalculation.ts will handle
        } else {
          waypoint.address = 'Location not found';
        }
      } catch (error) {
        console.error('[RouteStore] Forward geocode error in searchAndSetWaypointAddress:', error);
        waypoint.address = 'Search failed';
      } finally {
        waypoint.isGeocoding = false;
      }
      console.log('--- [RouteStore] searchAndSetWaypointAddress FINISHED ---');
    },

    async calculateHardRoute() {
      console.log('--- [RouteStore] calculateHardRoute CALLED ---');
      if (this.waypoints.length < 2) {
        // console.warn('[RouteStore] calculateHardRoute EXIT: Less than 2 waypoints in this.waypoints.');
        this.route = null;
        return;
      }
      const validWaypoints = this.waypoints.filter((wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0);
      console.log('[RouteStore] calculateHardRoute - Filtered validWaypoints:', JSON.parse(JSON.stringify(validWaypoints)));

      if (validWaypoints.length < 2) {
        // console.warn('[RouteStore] calculateHardRoute EXIT: Not enough valid waypoints for ORS. Count:', validWaypoints.length);
        this.route = null;
        return;
      }
      const coords = validWaypoints.map((wp) => [wp.coords[0], wp.coords[1]] as [number, number]);
      console.log('[RouteStore] calculateHardRoute - Coords for ORS:', JSON.parse(JSON.stringify(coords)));
      console.log('[RouteStore] calculateHardRoute - Making ORS call...');
      try {
        const data = await getRoute(coords);
        console.log('[RouteStore] calculateHardRoute - Data FROM ORS:', data ? JSON.stringify(data).substring(0, 300) + '...' : 'null/undefined');
        this.route = orsToFeatureCollection(data);
        console.log(
          '[RouteStore] calculateHardRoute - New this.route set after orsToFeatureCollection:',
          this.route ? JSON.stringify(this.route).substring(0, 300) + '...' : 'null'
        );
      } catch (error) {
        console.error('[RouteStore] Error in calculateHardRoute getRoute:', error);
        this.route = null;
      }
      console.log('--- [RouteStore] calculateHardRoute FINISHED ---');
    },

    async applyShaping() {
      console.log('--- [RouteStore] applyShaping CALLED ---');
      console.log('[RouteStore] applyShaping - Initial this.route:', this.route ? JSON.stringify(this.route).substring(0, 200) + '...' : 'null');
      console.log('[RouteStore] applyShaping - Current waypoints:', JSON.parse(JSON.stringify(this.waypoints)));
      console.log('[RouteStore] applyShaping - Current shapingPoints:', JSON.parse(JSON.stringify(this.shapingPoints)));

      if (!this.route) {
        // console.warn('[RouteStore] applyShaping GUARD 1A: this.route is null. Attempting to calculateHardRoute first.');
        await this.calculateHardRoute();
        if (!this.route) {
          console.warn('[RouteStore] applyShaping EXIT (GUARD 1B): Still no base route after trying calculateHardRoute. Cannot apply shaping.');
          return;
        }
        console.log('[RouteStore] applyShaping - Base route now exists after calculateHardRoute call. Proceeding.');
      } else if (!this.route.features || this.route.features.length === 0) {
        // console.warn('[RouteStore] applyShaping EXIT (GUARD 1C): this.route exists but has no features. Cannot apply shaping.');
        return;
      }

      if (this.shapingPoints.length === 0) {
        // console.warn('[RouteStore] applyShaping EXIT (GUARD 2): No shaping points to apply.');
        return;
      }

      const validWaypoints = this.waypoints.filter((wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0);
      console.log('[RouteStore] applyShaping - Filtered validWaypoints:', JSON.parse(JSON.stringify(validWaypoints)));

      if (validWaypoints.length < 2) {
        // console.warn('[RouteStore] applyShaping EXIT (GUARD 3): Not enough valid hard waypoints for shaping. Count:', validWaypoints.length);
        this.route = null;
        return;
      }

      const sortedShapingPoints = [...this.shapingPoints].sort((a, b) => {
        if (a.idx === b.idx) {
          return 0;
        }
        return a.idx - b.idx;
      });
      console.log('[RouteStore] applyShaping - Sorted shapingPoints for processing:', JSON.parse(JSON.stringify(sortedShapingPoints)));

      const finalCoordsForORS: Coord[] = [];

      if (validWaypoints.length === 2) {
        console.log('[RouteStore] applyShaping: Branch for 2 valid waypoints.');
        finalCoordsForORS.push(validWaypoints[0].coords);
        sortedShapingPoints.forEach((sp) => finalCoordsForORS.push(sp.coord));
        finalCoordsForORS.push(validWaypoints[1].coords);
      } else {
        console.log('[RouteStore] applyShaping: Branch for >2 valid waypoints.');
        let currentShapingPointProcessingIdx = 0;
        for (let i = 0; i < validWaypoints.length; i++) {
          finalCoordsForORS.push(validWaypoints[i].coords);
          console.log(
            `[RouteStore] applyShaping (>2WP): Added waypoint ${i} (ID: ${validWaypoints[i].id}, Coords: ${JSON.stringify(
              validWaypoints[i].coords
            )}) to finalCoordsForORS.`
          );
          if (i < validWaypoints.length - 1) {
            console.log(`[RouteStore] applyShaping (>2WP): Looking for SPs with .idx === ${i + 1} (to fit between WP ${i} and WP ${i + 1})`);
            while (currentShapingPointProcessingIdx < sortedShapingPoints.length && sortedShapingPoints[currentShapingPointProcessingIdx].idx === i + 1) {
              finalCoordsForORS.push(sortedShapingPoints[currentShapingPointProcessingIdx].coord);
              console.log(
                `[RouteStore] applyShaping (>2WP): Added SP ${sortedShapingPoints[currentShapingPointProcessingIdx].id} (idx: ${
                  sortedShapingPoints[currentShapingPointProcessingIdx].idx
                }, coord: ${JSON.stringify(sortedShapingPoints[currentShapingPointProcessingIdx].coord)}) to finalCoordsForORS.`
              );
              currentShapingPointProcessingIdx++;
            }
          }
        }
      }

      console.log('[RouteStore] applyShaping - Constructed finalCoordsForORS:', JSON.parse(JSON.stringify(finalCoordsForORS)));

      if (finalCoordsForORS.length < 2) {
        // console.warn('[RouteStore] applyShaping EXIT (GUARD 4): Not enough coordinates in finalCoordsForORS for ORS. Count:', finalCoordsForORS.length, 'Reverting to hard route.');
        await this.calculateHardRoute();
        return;
      }

      console.log('[RouteStore] applyShaping - Making ORS call with finalCoordsForORS...');
      try {
        const data = await getRoute(finalCoordsForORS);
        console.log('[RouteStore] applyShaping - Data FROM ORS:', data ? JSON.stringify(data).substring(0, 300) + '...' : 'null/undefined');
        this.route = orsToFeatureCollection(data);
        console.log('[RouteStore] applyShaping - New this.route set:', this.route ? JSON.stringify(this.route).substring(0, 300) + '...' : 'null');
      } catch (error) {
        console.error('[RouteStore] Error in applyShaping getRoute:', error);
      }
      console.log('--- [RouteStore] applyShaping FINISHED ---');
    },

    async recalc(options: { forceGlobalOptimize?: boolean } = {}) {
      console.log(
        `--- [RouteStore] recalc CALLED --- Options: ${options ? JSON.stringify(options) : '{}'}, Current shaping points count: ${this.shapingPoints.length}`
      );
      this.isCalculatingGlobalRoute = !!options?.forceGlobalOptimize;
      if (options?.forceGlobalOptimize) {
        console.log('[RouteStore] recalc: Forcing global optimize, clearing shaping points.');
        this.shapingPoints = [];
      }

      await this.calculateHardRoute();

      console.log('[RouteStore] recalc - After calculateHardRoute, this.route is:', this.route ? JSON.stringify(this.route).substring(0, 100) + '...' : 'null');

      if (this.shapingPoints.length > 0 && this.route && this.route.features && this.route.features.length > 0) {
        console.log('[RouteStore] recalc: Conditions met to call applyShaping.');
        await this.applyShaping();
      } else {
        console.log(
          `[RouteStore] recalc: Conditions NOT met to call applyShaping. ShapingPoints count: ${this.shapingPoints.length}, Route valid: ${!!(
            this.route &&
            this.route.features &&
            this.route.features.length > 0
          )}`
        );
      }
      this.isCalculatingGlobalRoute = false;
      console.log('--- [RouteStore] recalc FINISHED ---');
    },

    async geocodeWaypoint(waypointId: string) {
      console.log(`--- [RouteStore] geocodeWaypoint CALLED - ID: ${waypointId} ---`);
      const waypoint = this.waypoints.find((wp) => wp.id === waypointId);
      if (!waypoint) {
        // console.warn('[RouteStore] geocodeWaypoint: Waypoint not found for ID:', waypointId);
        return;
      }
      if (
        waypoint.coords[0] === 0 &&
        waypoint.coords[1] === 0 &&
        (waypoint.address === 'Start Point' || waypoint.address === 'End Point' || waypoint.address === 'Via Point' || !waypoint.address)
      ) {
        console.log('[RouteStore] geocodeWaypoint: Skipping geocode for placeholder waypoint:', JSON.parse(JSON.stringify(waypoint)));
        waypoint.isGeocoding = false;
        if (waypoint.address && (!waypoint.userInput || waypoint.userInput === 'Loading address...')) {
          waypoint.userInput = waypoint.address;
        }
        return;
      }

      waypoint.isGeocoding = true;
      const currentAddressDisplay = waypoint.address;
      waypoint.address = 'Loading address...';

      try {
        const place = await reverseGeocode(waypoint.coords);
        console.log('[RouteStore] geocodeWaypoint - Reverse geocode result:', place);
        const newAddress = place?.label ?? 'Address not found';
        waypoint.address = newAddress;
        waypoint.userInput = newAddress;
        waypoint.kind = place?.kind || waypoint.kind;
      } catch (err) {
        console.error('[RouteStore] Geocode waypoint error:', err);
        waypoint.address = currentAddressDisplay !== 'Loading address...' ? currentAddressDisplay : 'Address lookup failed';
      } finally {
        waypoint.isGeocoding = false;
      }
      console.log('--- [RouteStore] geocodeWaypoint FINISHED ---');
    },

    async addWaypointByClick(coord: Coord) {
      console.log('--- [RouteStore] addWaypointByClick CALLED - Coord:', JSON.stringify(coord) + ' ---');
      const startWp = this.waypoints.find((wp) => wp.kind === 'start');
      const endWp = this.waypoints.find((wp) => wp.kind === 'end');
      let waypointToUpdateId: string | undefined;

      if (startWp && startWp.coords[0] === 0 && startWp.coords[1] === 0) {
        console.log('[RouteStore] addWaypointByClick: Updating Start waypoint.');
        startWp.coords = coord;
        startWp.userInput = 'Loading address...';
        waypointToUpdateId = startWp.id;
      } else if (endWp && endWp.coords[0] === 0 && endWp.coords[1] === 0) {
        console.log('[RouteStore] addWaypointByClick: Updating End waypoint.');
        endWp.coords = coord;
        endWp.userInput = 'Loading address...';
        waypointToUpdateId = endWp.id;
      } else {
        console.log('[RouteStore] addWaypointByClick: Adding new Via waypoint.');
        const newWp = this._addWaypointInternal(coord, 'via', 'Loading address...', '');
        const endIndex = this.waypoints.findIndex((wp) => wp.kind === 'end');
        if (endIndex !== -1) {
          this.waypoints.splice(endIndex, 0, newWp);
        } else {
          this.waypoints.push(newWp);
        }
        waypointToUpdateId = newWp.id;
      }
      console.log('[RouteStore] addWaypointByClick - Waypoints state before recalc:', JSON.parse(JSON.stringify(this.waypoints)));
      // await this.recalc(); // REMOVED - Watcher will handle
      if (waypointToUpdateId) {
        await this.geocodeWaypoint(waypointToUpdateId); // geocodeWaypoint itself does not call recalc.
        // The change to waypoint.address by geocoding IS watched by useRouteCalculation.ts
        // if waypoints are stringified fully including address for the watcher.
        // Current watcher stringifies routeStore.waypoints, so it should pick up address change.
      }
      console.log('--- [RouteStore] addWaypointByClick FINISHED ---');
    },

    async addPlaceAsWaypoint(place: Place) {
      console.log('--- [RouteStore] addPlaceAsWaypoint CALLED --- Place:', JSON.stringify(place).substring(0, 100) + '...');
      const startWp = this.waypoints.find((wp) => wp.kind === 'start');
      const endWp = this.waypoints.find((wp) => wp.kind === 'end');

      const newWpData = {
        coords: place.coord,
        address: place.label,
        isGeocoding: false,
        kind: place.kind || 'poi',
        userInput: place.label,
      };

      if (startWp && startWp.coords[0] === 0 && startWp.coords[1] === 0 && startWp.address === 'Start Point') {
        console.log('[RouteStore] addPlaceAsWaypoint: Updating Start waypoint with place.');
        Object.assign(startWp, { ...newWpData, kind: 'start' });
      } else if (endWp && endWp.coords[0] === 0 && endWp.coords[1] === 0 && endWp.address === 'End Point') {
        console.log('[RouteStore] addPlaceAsWaypoint: Updating End waypoint with place.');
        Object.assign(endWp, { ...newWpData, kind: 'end' });
      } else {
        console.log('[RouteStore] addPlaceAsWaypoint: Adding new Via waypoint with place.');
        const createdWp = this._addWaypointInternal(place.coord, place.kind || 'poi', place.label, place.label);
        const endIndex = this.waypoints.findIndex((w) => w.kind === 'end');
        if (endIndex !== -1) {
          this.waypoints.splice(endIndex, 0, createdWp);
        } else {
          this.waypoints.push(createdWp);
        }
      }
      // await this.recalc(); // REMOVED - Watcher will handle
      console.log('--- [RouteStore] addPlaceAsWaypoint FINISHED ---');
    },

    async insertWaypointOnRoute(indexAfter: number, coord: Coord) {
      console.log(`--- [RouteStore] insertWaypointOnRoute CALLED - IndexAfter: ${indexAfter}, Coord: ${JSON.stringify(coord)} ---`);
      const newWp = this._addWaypointInternal(coord, 'via', 'Loading address...', '');
      this.waypoints.splice(indexAfter, 0, newWp);
      // await this.recalc(); // REMOVED - Watcher will handle
      await this.geocodeWaypoint(newWp.id);
      console.log('--- [RouteStore] insertWaypointOnRoute FINISHED ---');
    },

    async insertShapingPoint(originalSegmentIdxPlusOne: number, coord: Coord) {
      console.log('--- [RouteStore] insertShapingPoint CALLED --- Idx:', originalSegmentIdxPlusOne, 'Coord:', JSON.stringify(coord));
      const newId = newShapePointId();
      this.shapingPoints.push({ id: newId, idx: originalSegmentIdxPlusOne, coord });
      this.shapingPoints.sort((a, b) => a.idx - b.idx);
      console.log('[RouteStore] shapingPoints AFTER insert:', JSON.parse(JSON.stringify(this.shapingPoints)));
      // await this.recalc(); // REMOVED - Watcher in useRouteCalculation.ts handles this
      console.log('--- [RouteStore] insertShapingPoint FINISHED ---');
    },

    async updateShapingPointCoord(id: string, newCoords: Coord) {
      console.log(`--- [RouteStore] updateShapingPointCoord CALLED - ID: ${id}, New Coords: ${JSON.stringify(newCoords)} ---`);
      const point = this.shapingPoints.find((sp) => sp.id === id);
      if (point) {
        point.coord = newCoords;
        // await this.recalc(); // REMOVED - Watcher will handle
      } else {
        // console.warn('[RouteStore] updateShapingPointCoord: Shaping point not found for ID:', id);
      }
      console.log('--- [RouteStore] updateShapingPointCoord FINISHED ---');
    },

    async updateWaypointCoord(waypointId: string, newCoords: Coord) {
      console.log(`--- [RouteStore] updateWaypointCoord CALLED - ID: ${waypointId}, New Coords: ${JSON.stringify(newCoords)} ---`);
      const waypoint = this.waypoints.find((wp) => wp.id === waypointId);
      if (!waypoint) {
        // console.warn('[RouteStore] updateWaypointCoord: Waypoint not found for ID:', waypointId);
        return;
      }
      waypoint.coords = newCoords;
      waypoint.userInput = 'Loading address...';
      this.shapingPoints = []; // This is by design from the prompt
      console.log('[RouteStore] updateWaypointCoord: Shaping points cleared.');
      // await this.recalc(); // REMOVED - Watcher will handle
      await this.geocodeWaypoint(waypointId);
      console.log('--- [RouteStore] updateWaypointCoord FINISHED ---');
    },

    async removeWaypoint(waypointId: string) {
      console.log(`--- [RouteStore] removeWaypoint CALLED - ID: ${waypointId} ---`);
      const index = this.waypoints.findIndex((wp) => wp.id === waypointId);
      if (index === -1) {
        // console.warn('[RouteStore] removeWaypoint: Waypoint not found for ID:', waypointId);
        return;
      }

      const waypoint = this.waypoints[index];
      const isStartOrEnd = waypoint.kind === 'start' || waypoint.kind === 'end';

      if (this.waypoints.length <= 2 && isStartOrEnd) {
        console.log('[RouteStore] removeWaypoint: Resetting Start/End waypoint.');
        waypoint.coords = [0, 0];
        waypoint.address = waypoint.kind === 'start' ? 'Start Point' : 'End Point';
        waypoint.userInput = waypoint.address;
        waypoint.isGeocoding = false;
      } else {
        console.log('[RouteStore] removeWaypoint: Splicing waypoint.');
        this.waypoints.splice(index, 1);
        if (isStartOrEnd && this.waypoints.length > 0) {
          if (!this.waypoints.find((wp) => wp.kind === 'start') && this.waypoints.length > 0) {
            this.waypoints[0].kind = 'start';
            console.log('[RouteStore] removeWaypoint: Promoted new Start waypoint:', this.waypoints[0].id);
          }
          if (!this.waypoints.find((wp) => wp.kind === 'end') && this.waypoints.length > 0) {
            this.waypoints[this.waypoints.length - 1].kind = 'end';
            console.log('[RouteStore] removeWaypoint: Promoted new End waypoint:', this.waypoints[this.waypoints.length - 1].id);
          }
        }
      }
      this.shapingPoints = [];
      console.log('[RouteStore] removeWaypoint: Shaping points cleared.');
      // await this.recalc(); // REMOVED - Watcher will handle
      console.log('--- [RouteStore] removeWaypoint FINISHED ---');
    },

    async clearShaping() {
      console.log('--- [RouteStore] clearShaping CALLED ---');
      this.shapingPoints = [];
      // await this.recalc(); // REMOVED - Watcher will handle
      console.log('--- [RouteStore] clearShaping FINISHED ---');
    },

    async optimizeEntireRoute() {
      // This action specifically calls recalc with options
      console.log('--- [RouteStore] optimizeEntireRoute CALLED ---');
      await this.recalc({ forceGlobalOptimize: true });
      console.log('--- [RouteStore] optimizeEntireRoute FINISHED ---');
    },
  },
});

function orsToFeatureCollection(orsData: any): FeatureCollection {
  console.log('--- [RouteStore] orsToFeatureCollection processing data ---:', orsData ? JSON.stringify(orsData).substring(0, 100) + '...' : 'null/undefined');
  if (!orsData) {
    // console.warn('[RouteStore] orsToFeatureCollection: Input data is null or undefined. Returning empty FeatureCollection.');
    return { type: 'FeatureCollection', features: [] };
  }
  if (orsData.type === 'FeatureCollection' && Array.isArray(orsData.features)) {
    if (orsData.features.length === 0) {
      console.log('[RouteStore] orsToFeatureCollection: Input is a FeatureCollection with zero features.');
      return orsData as FeatureCollection;
    }
    if (orsData.features.length > 0 && orsData.features[0].geometry) {
      console.log('[RouteStore] orsToFeatureCollection: Input is already a valid FeatureCollection with features.');
      if (!orsData.features[0].properties) orsData.features[0].properties = {};
      if (orsData.features[0].geometry.type === 'LineString' && orsData.extras) {
        orsData.features[0].properties.extras = orsData.extras;
      }
      if (!orsData.features[0].properties.summary && orsData.summary) {
        orsData.features[0].properties.summary = orsData.summary;
      }
      return orsData as FeatureCollection;
    }
  }
  if (orsData?.routes?.[0]?.geometry) {
    console.log('[RouteStore] orsToFeatureCollection: Converting from ORS routes structure.');
    const routeProperties: GeoJsonProperties = {
      ...(orsData.routes[0].summary && { summary: orsData.routes[0].summary }),
      ...(orsData.extras && { extras: orsData.extras }),
    };
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: orsData.routes[0].geometry,
          properties: routeProperties,
        },
      ],
    } as FeatureCollection;
  }
  // console.warn('[RouteStore] orsToFeatureCollection: Data not in recognized format. Returning empty FeatureCollection. Data was:', JSON.stringify(orsData).substring(0,300)+"...");
  return { type: 'FeatureCollection', features: [] };
}

export type RouteStore = ReturnType<typeof useRouteStore>;

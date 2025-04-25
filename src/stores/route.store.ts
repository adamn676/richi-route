// src/stores/route.store.ts

import { defineStore } from "pinia";
import type { FeatureCollection } from "geojson";
import { getRoute } from "@/services/route.service";
import { reverseGeocode, type Place } from "@/services/maptiler.service";

export type Coord = [number, number];

interface ShapePoint {
  idx: number; // index in the backbone coords
  coord: Coord; // the drag-to-shape coordinate
}

export const useRouteStore = defineStore("route", {
  state: () => ({
    // Hard stops (start → via… → end)
    waypoints: [] as Coord[],

    // Human-readable labels for each waypoint
    addresses: [] as (string | null)[],

    // Loading flags for reverse geocoding
    isGeocoding: [] as boolean[],

    // Soft shaping tweaks
    shapingPoints: [] as ShapePoint[],

    // Place kinds for each waypoint (poi, address, road, etc.)
    kinds: [] as string[],

    // The resulting GeoJSON route
    route: null as FeatureCollection | null,
  }),

  actions: {
    /**
     * Ensures we start with exactly 2 placeholder waypoints
     * for Start & End in the UI. (Both at [0,0], addresses null.)
     * Call this on app startup or in onMounted of your panel
     * so you always see 2 input fields right away.
     */
    initMinimumWaypoints() {
      while (this.waypoints.length < 2) {
        this.waypoints.push([0, 0]);
        this.addresses.push(null);
        this.isGeocoding.push(false);
        this.kinds.push("address");
      }
    },

    /** Main ORS call over hard stops only */
    async calculateHardRoute() {
      if (this.waypoints.length < 2) return;
      this.route = await getRoute(this.waypoints);
    },

    /** Apply shaping points if needed */
    async applyShaping() {
      if (!this.route) return;

      // If exactly start/end + shaping => single global call
      if (this.waypoints.length === 2 && this.shapingPoints.length) {
        const coords = [
          this.waypoints[0],
          ...this.shapingPoints.map((p) => p.coord),
          this.waypoints[1],
        ];
        this.route = await getRoute(coords);
        return;
      }

      // Otherwise, re-route each leg individually
      const original = (this.route?.features[0].geometry as any)
        .coordinates as Coord[];
      let merged = original.slice();

      for (const { idx, coord } of this.shapingPoints) {
        if (idx < 0 || idx + 1 >= original.length) continue;
        const startCoord = original[idx];
        const endCoord = original[idx + 1];
        const localGeo = await getRoute([startCoord, coord, endCoord]);
        const localCoords = (localGeo.features[0].geometry as any)
          .coordinates as Coord[];
        merged.splice(idx, 2, ...localCoords);
      }

      this.route = {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "LineString", coordinates: merged },
            properties: {},
          },
        ],
      };
    },

    /** Master recalculation: backbone + shaping */
    async recalc() {
      await this.calculateHardRoute();
      if (this.shapingPoints.length) {
        await this.applyShaping();
      }
    },

    /** Reverse-geocode a single waypoint index */
    async geocodeWaypoint(index: number) {
      this.isGeocoding[index] = true;
      const coord = this.waypoints[index];
      try {
        const place = await reverseGeocode(coord);
        this.addresses[index] = place?.label ?? null;
        this.kinds[index] = place?.kind ?? "";
      } catch {
        this.addresses[index] = "Lookup failed";
        this.kinds[index] = "";
      } finally {
        this.isGeocoding[index] = false;
      }
    },

    /**
     * Add a new hard stop at the end + recalc + geocode
     * (For typical usage if we want to just push a new waypoint.)
     */
    async addWaypoint(coord: Coord) {
      this.waypoints.push(coord);
      this.addresses.push(null);
      this.isGeocoding.push(false);
      this.kinds.push("address");
      await this.recalc();
      await this.geocodeWaypoint(this.waypoints.length - 1);
    },

    /** Add a full Place (with kind) + recalc + set label/kind */
    async addPlace(place: Place) {
      this.waypoints.push(place.coord);
      this.addresses.push(place.label);
      this.isGeocoding.push(false);
      this.kinds.push(place.kind);
      await this.recalc();
    },

    /** Insert at segment click + recalc + geocode */
    async insertWaypoint(i: number, coord: Coord) {
      this.waypoints.splice(i, 0, coord);
      this.addresses.splice(i, 0, null);
      this.isGeocoding.splice(i, 0, false);
      this.kinds.splice(i, 0, "address");
      await this.recalc();
      await this.geocodeWaypoint(i);
    },

    /** Add a soft shaping point + recalc */
    async insertShapingPoint(idx: number, coord: Coord) {
      this.shapingPoints.splice(idx, 0, { idx, coord });
      await this.recalc();
    },

    /** Remove a hard stop (start/via/end) + recalc */
    async removeWaypoint(i: number) {
      this.waypoints.splice(i, 1);
      this.addresses.splice(i, 1);
      this.isGeocoding.splice(i, 1);
      this.kinds.splice(i, 1);
      // Clear shaping to avoid index mismatches
      this.shapingPoints = [];
      await this.recalc();
    },

    /** Clear all shaping tweaks + recalc */
    async clearShaping() {
      this.shapingPoints = [];
      await this.recalc();
    },

    /**
     * Update a specific waypoint's coordinate, address, and kind,
     * then recalc.
     * Called when user confirms a new location in the side panel,
     * or if we want to programmatically set an existing waypoint.
     */
    async updateWaypoint(
      index: number,
      coord: Coord,
      address: string | null,
      kind = "address"
    ) {
      if (index < 0 || index >= this.waypoints.length) return;
      this.waypoints[index] = coord;
      this.addresses[index] = address;
      this.kinds[index] = kind;
      await this.recalc();
    },

    /**
     * The special action you'll call whenever the user clicks on the map.
     *
     * 1) If Start isn't set yet (addresses[0] is null), set that as the Start.
     * 2) Else if End isn't set yet (addresses[1] is null), set that as the End.
     * 3) Otherwise, we have Start + End =>
     *    the old End becomes a via waypoint,
     *    and the newly clicked coord becomes the new End.
     */
    async mapClick(coord: Coord) {
      // 1) If we don't have a real Start yet
      if (this.addresses[0] === null) {
        await this.updateWaypoint(0, coord, null, "address");
        await this.geocodeWaypoint(0);
        return;
      }

      // 2) If we don't have a real End yet
      if (this.addresses[1] === null) {
        await this.updateWaypoint(1, coord, null, "address");
        await this.geocodeWaypoint(1);
        return;
      }

      // 3) We already have Start + End =>
      //    The old End moves to "previous waypoint",
      //    The new click becomes the new End.

      // 3a) Pop the old End from the arrays
      const iEnd = this.waypoints.length - 1;

      const oldEndCoord = this.waypoints.pop()!;
      const oldEndAddr = this.addresses.pop()!;
      const oldEndKind = this.kinds.pop()!;
      const oldEndGeo = this.isGeocoding.pop()!;

      // 3b) Insert that old End as a "via" waypoint (second-last).
      this.waypoints.push(oldEndCoord);
      this.addresses.push(oldEndAddr);
      this.kinds.push(oldEndKind);
      this.isGeocoding.push(oldEndGeo);

      // 3c) Now add the new End as the final waypoint
      await this.addWaypoint(coord);
    },
  },
});

export type RouteStore = ReturnType<typeof useRouteStore>;

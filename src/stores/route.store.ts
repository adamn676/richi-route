import { defineStore } from "pinia";
import type { FeatureCollection } from "geojson";
import { getRoute } from "@/services/route.service";
import { reverseGeocode, type Place } from "@/services/maptiler.service";

export type Coord = [number, number];

interface ShapePoint {
  idx: number; // index in the backbone coords
  coord: Coord; // the drag‑to‑shape coordinate
}

export const useRouteStore = defineStore("route", {
  state: () => ({
    // Hard stops (start → via… → end)
    waypoints: [] as Coord[],

    // Human‑readable labels for each waypoint
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
    /** ORS call over hard stops only */
    async calculateHardRoute() {
      if (this.waypoints.length < 2) return;
      this.route = await getRoute(this.waypoints);
    },

    /** Splice in each shaping point */
    async applyShaping() {
      if (!this.route) return;

      // special-case: exactly start/end + shaping -> one global ORS call
      if (this.waypoints.length === 2 && this.shapingPoints.length) {
        const coords: Coord[] = [
          this.waypoints[0],
          ...this.shapingPoints.map((p) => p.coord),
          this.waypoints[1],
        ];
        this.route = await getRoute(coords);
        return;
      }

      // otherwise, reroute each leg individually
      const original = (this.route.features[0].geometry as any)
        .coordinates as Coord[];
      let merged = original.slice();

      for (const { idx, coord } of this.shapingPoints) {
        if (idx < 0 || idx + 1 >= original.length) continue;
        const startCoord = original[idx];
        const endCoord = original[idx + 1];
        const localGeo = await getRoute([startCoord, coord, endCoord]);
        const localCoords = (localGeo.features[0].geometry as any)
          .coordinates as Coord[];
        // replace the straight segment with the curved one
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

    /** Reverse‑geocode a single waypoint index */
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

    /** Add a new hard stop + recalc + geocode */
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
      // clear all shaping to avoid idx mismatch
      this.shapingPoints = [];
      await this.recalc();
    },

    /** Clear all shaping tweaks + recalc */
    async clearShaping() {
      this.shapingPoints = [];
      await this.recalc();
    },
  },
});

export type RouteStore = ReturnType<typeof useRouteStore>;

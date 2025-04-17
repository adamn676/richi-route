// src/stores/route.store.ts
import { defineStore } from "pinia";
import type { FeatureCollection } from "geojson";
import { getRoute } from "@/services/route.service";

type Coord = [number, number];

interface ShapePoint {
  idx: number; // index of the segment in the backbone coords
  coord: Coord; // the drag‑to‑shape coordinate
}

export const useRouteStore = defineStore("route", {
  state: () => ({
    waypoints: [] as Coord[], // hard stops only
    shapingPoints: [] as ShapePoint[], // soft shaping tweaks
    route: null as FeatureCollection | null,
  }),

  actions: {
    /** Phase 1: full ORS call over hard stops only */
    async calculateHardRoute() {
      if (this.waypoints.length < 2) return;
      this.route = await getRoute(this.waypoints);
    },

    /** Phase 2: apply each shaping point */
    async applyShaping() {
      if (!this.route) return;

      // **Special‑case**: only 2 hard stops → route through all shaping in one go
      if (this.waypoints.length === 2) {
        const coords: Coord[] = [
          this.waypoints[0],
          ...this.shapingPoints.map((p) => p.coord),
          this.waypoints[1],
        ];
        this.route = await getRoute(coords);
        return;
      }

      // Otherwise, splice each leg individually
      const original = (this.route.features[0].geometry as any)
        .coordinates as Coord[];
      let merged: Coord[] = original.slice();

      for (const { idx, coord } of this.shapingPoints) {
        // guard
        if (idx < 0 || idx + 1 >= original.length) continue;

        const startCoord = original[idx];
        const endCoord = original[idx + 1];

        const localGeo = await getRoute([startCoord, coord, endCoord]);
        const localCoords = (localGeo.features[0].geometry as any)
          .coordinates as Coord[];

        // remove the two‑point straight segment, insert the curved one
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

    /** Public API: all mutations call recalc() */
    async addWaypoint(coord: Coord) {
      this.waypoints.push(coord);
      await this.recalc();
    },
    async insertWaypoint(i: number, coord: Coord) {
      this.waypoints.splice(i, 0, coord);
      await this.recalc();
    },
    async insertShapingPoint(idx: number, coord: Coord) {
      this.shapingPoints.splice(idx, 0, { idx, coord });
      await this.recalc();
    },
    async clearShaping() {
      this.shapingPoints = [];
      await this.recalc();
    },
  },
});

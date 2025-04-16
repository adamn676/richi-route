// src/stores/route.store.ts
import { defineStore } from "pinia";
import type { FeatureCollection } from "geojson";
import { getRoute } from "@/services";

export interface Waypoint {
  id: string; // "start", "end", or "wp-<timestamp>"
  coord: [number, number]; // [lng, lat]
}

/**
 * A simple variable to hold our debounce timer.
 * We only do an actual ORS call once the user stops updating for a short time.
 */
let calcTimeout: number | null = null;

export const useRouteStore = defineStore("route", {
  state: () => ({
    waypoints: [] as Waypoint[],
    routeData: null as FeatureCollection | null,
  }),

  getters: {
    getWaypointById: (state) => (id: string) =>
      state.waypoints.find((wp) => wp.id === id),
    orderedWaypoints: (state) => {
      return [...state.waypoints].sort((a, b) => {
        if (a.id === "start") return -1;
        if (b.id === "start") return 1;
        if (a.id === "end") return 1;
        if (b.id === "end") return -1;
        return state.waypoints.indexOf(a) - state.waypoints.indexOf(b);
      });
    },
  },

  actions: {
    addWaypoint(newWp: Waypoint) {
      const hasStart = this.waypoints.some((wp) => wp.id === "start");
      const hasEnd = this.waypoints.some((wp) => wp.id === "end");

      if (!hasStart && newWp.id === "start") {
        this.waypoints.unshift(newWp);
        return;
      }
      if (!hasEnd && newWp.id === "end") {
        this.waypoints.push(newWp);
        return;
      }

      if (newWp.id === "end") {
        this.waypoints = this.waypoints.filter((wp) => wp.id !== "end");
        this.waypoints.push(newWp);
        return;
      }

      const endIndex = this.waypoints.findIndex((wp) => wp.id === "end");
      if (endIndex === -1) {
        this.waypoints.push(newWp);
      } else {
        this.waypoints.splice(endIndex, 0, newWp);
      }
    },

    updateWaypoint(id: string, newCoord: [number, number]) {
      const wp = this.waypoints.find((w) => w.id === id);
      if (wp) {
        wp.coord = newCoord;
      }
    },

    removeWaypoint(id: string) {
      if (id === "start" || id === "end") {
        console.warn(`Cannot remove waypoint "${id}"`);
        return;
      }
      this.waypoints = this.waypoints.filter((wp) => wp.id !== id);
      if (this.waypoints.length < 2) {
        this.routeData = null;
      } else {
        this.calculateRoute();
      }
    },

    /**
     * Public method: we call this whenever we want to recalc the route,
     * but we use a short debounce to avoid multiple calls in quick succession.
     */
    calculateRoute(delay = 200) {
      if (calcTimeout) {
        clearTimeout(calcTimeout);
      }
      calcTimeout = window.setTimeout(() => {
        this._calculateRouteNow();
      }, delay);
    },

    /**
     * The actual route calculation that calls getRoute().
     * We keep it private (underscore prefix) so external code calls only "calculateRoute()".
     */
    async _calculateRouteNow() {
      if (this.waypoints.length < 2) {
        this.routeData = null;
        return;
      }

      try {
        const coords = this.orderedWaypoints.map((wp) => wp.coord);
        const data = await getRoute(coords);
        this.routeData = data;
      } catch (err) {
        console.error("ORS error:", err);
        this.routeData = null;
      }
    },
  },
});

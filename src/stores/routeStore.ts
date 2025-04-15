// src/stores/routeStore.ts
import { defineStore } from "pinia";
import axios from "axios";

export interface Waypoint {
  id: string; // "start", "end", or "wp-<timestamp>"
  coord: [number, number]; // [lng, lat]
}

export const useRouteStore = defineStore("route", {
  state: () => ({
    waypoints: [] as Waypoint[],
    routeData: null as GeoJSON.FeatureCollection | null,
  }),

  getters: {
    getWaypointById: (state) => (id: string) =>
      state.waypoints.find((wp) => wp.id === id),

    // Sort so that 'start' is always first, 'end' is last
    // Intermediates remain in the order they were inserted
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

      // If replacing end
      if (newWp.id === "end") {
        this.waypoints = this.waypoints.filter((wp) => wp.id !== "end");
        this.waypoints.push(newWp);
        return;
      }

      // Otherwise an intermediate
      const endIndex = this.waypoints.findIndex((wp) => wp.id === "end");
      if (endIndex === -1) {
        this.waypoints.push(newWp);
      } else {
        // Insert before end
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

    async calculateRoute() {
      if (this.waypoints.length < 2) {
        this.routeData = null;
        return;
      }

      try {
        const orsApiKey = import.meta.env.VITE_ORS_API_KEY;
        const coords = this.orderedWaypoints.map((wp) => wp.coord);

        const response = await axios.post(
          "https://api.openrouteservice.org/v2/directions/cycling-regular/geojson",
          {
            coordinates: coords,
            preference: "recommended",
            extra_info: ["surface", "waytype", "steepness"],
          },
          {
            headers: {
              Authorization: orsApiKey,
              "Content-Type": "application/json",
            },
          }
        );

        this.routeData = response.data;
      } catch (err) {
        console.error("ORS error:", err);
        this.routeData = null;
      }
    },
  },
});

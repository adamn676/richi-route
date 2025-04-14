import { defineStore } from "pinia";
import axios from "axios";

interface RouteState {
  routeData: any | null;
  waypoints: [number, number][]; // [lng, lat] only
}

export const useRouteStore = defineStore("route", {
  state: (): RouteState => ({
    routeData: null,
    waypoints: [],
  }),
  actions: {
    addWaypoint(coord: [number, number]) {
      this.waypoints.push(coord);
    },
    async calculateRoute() {
      // Need at least 2 points for a route
      if (this.waypoints.length < 2) return;

      try {
        const orsApiKey = import.meta.env.VITE_ORS_API_KEY;
        // Log them to debug
        console.log("Calculating route for waypoints:", this.waypoints);
        console.log("Using ORS key:", orsApiKey);

        const response = await axios.post(
          "https://api.openrouteservice.org/v2/directions/cycling-regular/geojson",
          {
            coordinates: this.waypoints,
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

        console.log("ORS response:", response.data); // Debug output
        this.routeData = response.data;
      } catch (error) {
        console.error("Error fetching route from ORS:", error);
        this.routeData = null;
      }
    },
  },
});

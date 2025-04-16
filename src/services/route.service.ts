// import axios from "axios";
import { apiClient } from "@/services";

const API_KEY = import.meta.env.VITE_ORS_API_KEY;
const BASE_URL =
  "https://api.openrouteservice.org/v2/pdirections/cycling-road/geojson";
// const BASE_URL = "/ors-api/v2/directions/cycling-road/geojson";

export async function getRoute(coords: number[][]): Promise<any> {
  try {
    const response = await apiClient.post(
      BASE_URL,
      {
        coordinates: coords,
        elevation: true,
        instructions: false,
        preference: "recommended",
        extra_info: ["surface", "waytype", "steepness"],
      },
      {
        headers: {
          Authorization: API_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error fetching route:", error);
    throw error;
  }
}

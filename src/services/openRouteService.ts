import axios from "axios";

const API_KEY = import.meta.env.VITE_ORS_API_KEY;
const BASE_URL =
  "https://api.openrouteservice.org/v2/directions/cycling-regular/geojson";

export async function getRoute(coordinates: number[][]): Promise<any> {
  try {
    const response = await axios.post(
      BASE_URL,
      { coordinates, instructions: false },
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

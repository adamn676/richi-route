// src/stores/user.store.ts

import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import {
  geolocation,
  type GeolocationResult,
} from "@/services/geolocation.service";

// Use plain object instead of reactive data to prevent proxy issues
interface UserLocation {
  latitude: number;
  longitude: number;
  source: "browser" | "ip" | "stored";
  timestamp: number;
}

const LOCATION_STORAGE_KEY = "user-location";
const LOCATION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

export const useUserStore = defineStore("user", () => {
  // Using shallowRef to prevent deep reactivity that could cause proxy issues
  const info = shallowRef<UserLocation | null>(null);
  const isLoading = ref(false);
  const error = ref<string | null>(null);
  const isIpGeolocationActive = ref(false);
  const isBrowserGeolocationActive = ref(false);

  // Track geolocation attempt progress
  const hasAttemptedBrowserGeolocation = ref(false);
  const hasAttemptedIpGeolocation = ref(false);

  // Check if stored location exists and is recent enough
  function getStoredLocation(): UserLocation | null {
    try {
      const storedData = localStorage.getItem(LOCATION_STORAGE_KEY);
      if (!storedData) return null;

      const parsedData = JSON.parse(storedData) as UserLocation;
      const now = Date.now();

      // Validate stored data has required fields and isn't too old
      if (
        parsedData &&
        typeof parsedData.latitude === "number" &&
        typeof parsedData.longitude === "number" &&
        parsedData.timestamp &&
        now - parsedData.timestamp < LOCATION_MAX_AGE
      ) {
        return parsedData;
      }
      return null;
    } catch (e) {
      console.error("Failed to parse stored location", e);
      return null;
    }
  }

  // Save location to local storage
  function saveLocation(location: UserLocation) {
    try {
      localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(location));
    } catch (e) {
      console.error("Failed to save location to storage", e);
    }
  }

  // Get browser geolocation (returns promise)
  async function getBrowserLocation(): Promise<UserLocation> {
    isBrowserGeolocationActive.value = true;

    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Browser geolocation not supported"));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const location: UserLocation = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            source: "browser",
            timestamp: Date.now(),
          };
          // Resolve with the location data
          resolve(location);
        },
        (err) => {
          reject(new Error(`Geolocation error: ${err.message}`));
        },
        {
          maximumAge: 60000, // Accept a cached position up to 1 minute old
          timeout: 10000, // Wait at most 10 seconds
          enableHighAccuracy: false, // Don't need high accuracy for map centering
        }
      );
    });
  }

  // Get IP-based geolocation
  async function getIpLocation(): Promise<UserLocation> {
    isIpGeolocationActive.value = true;

    try {
      const result: GeolocationResult = await geolocation.info();

      if (result.latitude && result.longitude) {
        return {
          latitude: result.latitude,
          longitude: result.longitude,
          source: "ip",
          timestamp: Date.now(),
        };
      }
      throw new Error("IP geolocation data incomplete");
    } catch (error) {
      throw new Error(`IP geolocation failed: ${error}`);
    }
  }

  // Get location using all available methods in sequence
  async function fetchInfo() {
    isLoading.value = true;
    error.value = null;

    try {
      // 1. First try to use stored location if available and recent
      const storedLocation = getStoredLocation();
      if (storedLocation) {
        // Use stored location immediately
        info.value = storedLocation;
      }

      // 2. Try browser location first - it's more accurate
      try {
        isBrowserGeolocationActive.value = true;
        const browserLocation = await getBrowserLocation();

        // Update state in a synchronized way
        info.value = browserLocation;
        saveLocation(browserLocation);
        // IMPORTANT: Only mark these as complete AFTER updating the info
        hasAttemptedBrowserGeolocation.value = true;
        isBrowserGeolocationActive.value = false;
      } catch (browserError) {
        console.warn("Browser geolocation failed:", browserError);

        // Only after failure, mark the browser geolocation as attempted
        hasAttemptedBrowserGeolocation.value = true;
        isBrowserGeolocationActive.value = false;

        // 3. Fall back to IP location if browser location fails and we don't have a stored browser location
        if (!info.value || info.value.source !== "browser") {
          try {
            isIpGeolocationActive.value = true;
            const ipLocation = await getIpLocation();

            // Only update if we don't have a location yet or if current location is also IP-based
            if (!info.value || info.value.source === "ip") {
              info.value = ipLocation;
              saveLocation(ipLocation);
            }
            // Again, only mark these after updating info
            hasAttemptedIpGeolocation.value = true;
            isIpGeolocationActive.value = false;
          } catch (ipError) {
            console.warn("IP geolocation failed:", ipError);
            hasAttemptedIpGeolocation.value = true;
            isIpGeolocationActive.value = false;

            // If both failed and we don't have any location yet, throw error
            if (!info.value) {
              throw new Error("All geolocation methods failed");
            }
          }
        }
      }
    } catch (e) {
      console.error("Location determination failed:", e);
      error.value = "Failed to determine location";
    } finally {
      isLoading.value = false;
    }
  }

  // Function to manually retry IP geolocation if needed
  async function retryIpGeolocation() {
    if (isIpGeolocationActive.value) return false; // Already in progress

    try {
      isIpGeolocationActive.value = true;
      const ipLocation = await getIpLocation();

      if (!info.value || info.value.source === "ip") {
        info.value = ipLocation;
        saveLocation(ipLocation);
      }

      hasAttemptedIpGeolocation.value = true;
      isIpGeolocationActive.value = false;
      return true;
    } catch (error) {
      console.error("IP geolocation retry failed:", error);
      hasAttemptedIpGeolocation.value = true;
      isIpGeolocationActive.value = false;
      return false;
    }
  }

  // Check if the store was initialized with a stored location
  const initialStoredLocation = getStoredLocation();
  if (initialStoredLocation) {
    info.value = initialStoredLocation;
  }

  return {
    info,
    isLoading,
    isIpGeolocationActive,
    isBrowserGeolocationActive,
    hasAttemptedBrowserGeolocation,
    hasAttemptedIpGeolocation,
    error,
    fetchInfo,
    retryIpGeolocation,
  };
});

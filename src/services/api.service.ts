// src/services/api.service.ts
import axios from "axios";

/**
 * apiClient is a reusable axios instance for any HTTP calls.
 * You can configure interceptors for logging, auth tokens, etc.
 */
export const apiClient = axios.create({
  // baseURL can be set if you have a consistent prefix
  // e.g. baseURL: import.meta.env.VITE_API_BASE_URL || "",
  timeout: 10000,
});

// Optionally add request interceptors
apiClient.interceptors.request.use(
  (config) => {
    // e.g. add global headers or tokens
    // config.headers["Authorization"] = "Bearer someToken";
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Optionally add response interceptors
apiClient.interceptors.response.use(
  (response) => {
    // handle success
    return response;
  },
  (error) => {
    // global error handling
    console.error("API error:", error);
    // You could show a toast or log out the user, etc.
    return Promise.reject(error);
  }
);

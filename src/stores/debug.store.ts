// src/stores/debug.store.ts (or add to map.store.ts)
import { defineStore } from 'pinia';
import type { Coord } from '@/services/route.service';

export interface DebugRadiusVisualization {
  id: string; // e.g., waypoint or shaping point ID
  center: Coord;
  radius: number;
  type: 'waypoint' | 'shaping_point';
}

export interface DebugBearingVisualization {
  id: string; // e.g., shaping point ID or leg identifier
  origin: Coord;
  bearing: number; // Angle in degrees
  tolerance: number; // Tolerance in degrees
  length?: number; // Length of the line to draw for bearing
}

export const useDebugStore = defineStore('debug', {
  state: () => ({
    showDebugVisuals: false,
    radiusVisuals: [] as DebugRadiusVisualization[],
    bearingVisuals: [] as DebugBearingVisualization[],
    // You could add more debug data here, like the last ORS request payload
    lastOrsRequest: null as any,
    lastOrsResponse: null as any,
  }),
  actions: {
    toggleDebugVisuals() {
      this.showDebugVisuals = !this.showDebugVisuals;
      if (!this.showDebugVisuals) {
        this.clearVisuals();
      }
    },
    updateRadiusVisuals(visuals: DebugRadiusVisualization[]) {
      if (this.showDebugVisuals) {
        this.radiusVisuals = visuals;
      }
    },
    updateBearingVisuals(visuals: DebugBearingVisualization[]) {
      if (this.showDebugVisuals) {
        this.bearingVisuals = visuals;
      }
    },
    setLastOrsRequestPayload(payload: any) {
      this.lastOrsRequest = payload;
    },
    setLastOrsResponse(response: any) {
      this.lastOrsResponse = response;
    },
    clearVisuals() {
      this.radiusVisuals = [];
      this.bearingVisuals = [];
    },
  },
});

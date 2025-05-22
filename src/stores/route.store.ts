// src/stores/route.store.ts
import { defineStore } from 'pinia';
import type { FeatureCollection as GeoJSONFeatureCollection, GeoJsonProperties } from 'geojson'; // Standard GeoJSON types
import { getRoute, getRouteWithStickyShaping, type BearingValue, type Coord } from '@/services/route.service';
import type { OrsFeatureCollection } from '@/types'; // Your custom ORS type
import { reverseGeocode, type Place, forwardGeocode } from '@/services/maptiler.service';
import { DEFAULT_WAYPOINT_ORS_RADIUS } from '@/config/map.config';

let waypointIdCounter = 0;
const newWaypointId = () => `wp-${waypointIdCounter++}`;

let shapePointIdCounter = 0;
const newShapePointId = () => `sp-${shapePointIdCounter++}`;

export interface ShapePoint {
  id: string;
  idx: number;
  coord: Coord;
  radius: number;
}

export interface Waypoint {
  id: string;
  coords: Coord;
  address: string | null;
  isGeocoding: boolean;
  kind: string;
  userInput?: string;
}

export const useRouteStore = defineStore('route', {
  state: () => ({
    waypoints: [
      {
        id: newWaypointId(),
        coords: [0, 0] as Coord,
        address: 'Start Point',
        isGeocoding: false,
        kind: 'start',
        userInput: '',
      },
      {
        id: newWaypointId(),
        coords: [0, 0] as Coord,
        address: 'End Point',
        isGeocoding: false,
        kind: 'end',
        userInput: '',
      },
    ] as Waypoint[],
    shapingPoints: [] as ShapePoint[],
    route: null as OrsFeatureCollection | null, // Use OrsFeatureCollection type
    isCalculatingGlobalRoute: false,
    draggedShapingPointInfo: null as { id: string; bearing: [number, number] } | null, // [value, range]
  }),

  actions: {
    setDraggedShapingPointBearing(info: { id: string; bearing: [number, number] } | null) {
      this.draggedShapingPointInfo = info;
    },
    clearDraggedShapingPointBearing() {
      this.draggedShapingPointInfo = null;
    },

    _addWaypointInternal(coord: Coord, kind: string, address: string | null = null, userInputInitialValue: string = ''): Waypoint {
      const newId = newWaypointId();
      const defaultAddressText = kind === 'start' ? 'Start Point' : kind === 'end' ? 'End Point' : 'Via Point';
      const finalAddress = address ?? defaultAddressText;
      const finalUserInput = userInputInitialValue || finalAddress || '';
      return {
        id: newId,
        coords: coord,
        address: finalAddress,
        isGeocoding: false,
        kind: kind,
        userInput: finalUserInput,
      };
    },

    async addIntermediateStopAndPrepare() {
      const newWp = this._addWaypointInternal([0, 0], 'via', 'New Via Point (Search or click map)', '');
      const endIndex = this.waypoints.findIndex((wp) => wp.kind === 'end');
      if (endIndex !== -1) {
        this.waypoints.splice(endIndex, 0, newWp);
      } else {
        this.waypoints.push(newWp);
      }
      // Recalc will be triggered by watcher
    },

    async searchAndSetWaypointAddress(waypointId: string, query: string) {
      const waypoint = this.waypoints.find((wp) => wp.id === waypointId);
      if (!waypoint) return;
      waypoint.isGeocoding = true;
      waypoint.userInput = query;
      waypoint.address = `Searching for "${query}"...`;
      try {
        const places = await forwardGeocode(query);
        if (places.length > 0) {
          const firstPlace = places[0];
          waypoint.coords = firstPlace.coord;
          waypoint.address = firstPlace.label;
          waypoint.userInput = firstPlace.label; // Keep userInput in sync with the chosen label
          waypoint.kind = firstPlace.kind || waypoint.kind;
        } else {
          waypoint.address = 'Location not found';
        }
      } catch (error) {
        console.error('[RouteStore] Forward geocode error:', error);
        waypoint.address = 'Search failed';
      } finally {
        waypoint.isGeocoding = false;
      }
      // Recalc will be triggered by watcher
    },

    async calculateHardRoute() {
      console.log('[RouteStore] calculateHardRoute CALLED');
      if (this.waypoints.length < 2) {
        this.route = null;
        return;
      }
      const validWaypoints = this.waypoints.filter((wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0);
      if (validWaypoints.length < 2) {
        this.route = null;
        return;
      }
      const coords = validWaypoints.map((wp) => wp.coords);
      const radiuses = validWaypoints.map(() => DEFAULT_WAYPOINT_ORS_RADIUS);
      const bearings = validWaypoints.map(() => null as BearingValue);

      console.log('[RouteStore] calculateHardRoute - Coords:', coords.length, 'Radiuses:', radiuses.length, 'Bearings (raw for getRoute):', bearings.length);
      try {
        const data = await getRoute(coords, radiuses, bearings);
        this.route = data; // getRoute now returns OrsFeatureCollection
      } catch (error) {
        console.error('[RouteStore] Error in calculateHardRoute getRoute:', error);
        this.route = null;
      }
    },

    // Helper function to build the full coordinate, radius, and bearing list for a single ORS call
    // This is used by the fallback mechanism in applyShaping or for general non-sticky shaping.
    _buildFullPointListForSingleCall(): { coords: Coord[]; radiuses: number[]; bearings: BearingValue[] } | null {
      const validWaypoints = this.waypoints.filter((wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0);
      if (validWaypoints.length < 2) {
        // Not enough waypoints to form a route, even with shaping points.
        return null;
      }

      const sortedShapingPoints = [...this.shapingPoints].sort((a, b) => a.idx - b.idx);

      const finalCoordsForORS: Coord[] = [];
      const finalRadiusesForORS: number[] = [];
      const finalBearingsForORS: BearingValue[] = []; // BearingValue is [number,number], [[in,out],[in,out]], or null

      let currentShapingPointProcessingIdx = 0;
      for (let i = 0; i < validWaypoints.length; i++) {
        finalCoordsForORS.push(validWaypoints[i].coords);
        finalRadiusesForORS.push(DEFAULT_WAYPOINT_ORS_RADIUS);
        // Bearings for hard waypoints in a generic call are typically null.
        // getRoute will filter to only use actual bearings if at overall start/end.
        finalBearingsForORS.push(null);

        if (i < validWaypoints.length - 1) {
          const targetSegmentOriginalIndex = i;
          while (
            currentShapingPointProcessingIdx < sortedShapingPoints.length &&
            sortedShapingPoints[currentShapingPointProcessingIdx].idx === targetSegmentOriginalIndex + 1
          ) {
            const sp = sortedShapingPoints[currentShapingPointProcessingIdx];
            finalCoordsForORS.push(sp.coord);
            finalRadiusesForORS.push(sp.radius);
            // If this SP is the one being actively dragged, include its bearing.
            // Otherwise, null. getRoute will filter this further.
            if (this.draggedShapingPointInfo && this.draggedShapingPointInfo.id === sp.id) {
              finalBearingsForORS.push(this.draggedShapingPointInfo.bearing as BearingValue);
            } else {
              finalBearingsForORS.push(null);
            }
            currentShapingPointProcessingIdx++;
          }
        }
      }

      if (finalCoordsForORS.length < 2) return null;
      return { coords: finalCoordsForORS, radiuses: finalRadiusesForORS, bearings: finalBearingsForORS };
    },

    async applyShaping() {
      console.log('[RouteStore] applyShaping CALLED. Active Dragged SP Info:', JSON.stringify(this.draggedShapingPointInfo));

      const validWaypoints = this.waypoints.filter((wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0);
      if (validWaypoints.length < 2) {
        this.route = null;
        this.clearDraggedShapingPointBearing();
        return;
      }

      // --- Attempt Two-Leg Strategy for a single, actively dragged "sticky" shaping point ---
      if (this.draggedShapingPointInfo && this.shapingPoints.length > 0) {
        const activeSp = this.shapingPoints.find((sp) => sp.id === this.draggedShapingPointInfo!.id);

        // Condition for simplest sticky case: Start WP - Dragged SP - End WP
        // (i.e., 2 hard waypoints, 1 shaping point which is the one being dragged)
        if (activeSp && validWaypoints.length === 2 && this.shapingPoints.length === 1 && this.shapingPoints[0].id === activeSp.id) {
          const startWp = validWaypoints[0];
          const endWp = validWaypoints[1];
          // draggedShapingPointInfo.bearing is already [value, range] (SimpleBearing)
          const spSimpleBearing = this.draggedShapingPointInfo.bearing;

          console.log(
            `[RouteStore] Attempting STICKY SHAPING for SP ${activeSp.id} between ${startWp.id} and ${endWp.id} with bearing ${JSON.stringify(spSimpleBearing)}`
          );
          try {
            const data = await getRouteWithStickyShaping(
              startWp.coords,
              activeSp.coord,
              endWp.coords,
              spSimpleBearing,
              DEFAULT_WAYPOINT_ORS_RADIUS,
              activeSp.radius,
              DEFAULT_WAYPOINT_ORS_RADIUS
            );
            this.route = data; // Directly use the OrsFeatureCollection
          } catch (error) {
            console.error('[RouteStore] Error in STICKY applyShaping:', error);
            console.log('[RouteStore] Falling back to standard shaping (single call) due to sticky shaping error.');
            const pointList = this._buildFullPointListForSingleCall();
            if (pointList) {
              this.route = await getRoute(pointList.coords, pointList.radiuses, pointList.bearings);
            } else {
              this.route = null;
            }
          } finally {
            this.clearDraggedShapingPointBearing();
          }
          return; // Exit after handling sticky shaping
        } else if (activeSp) {
          console.warn(
            '[RouteStore] Sticky shaping for SP ${activeSp.id} in a more complex route (multiple WPs/SPs) is not yet implemented. Falling back to standard shaping.'
          );
        }
      }

      // --- Fallback: Standard single-call shaping ---
      console.log('[RouteStore] Proceeding with standard shaping (single call).');
      const pointList = this._buildFullPointListForSingleCall();
      if (pointList) {
        try {
          // getRoute will correctly filter bearings to only allow start/end of the whole sequence
          const data = await getRoute(pointList.coords, pointList.radiuses, pointList.bearings);
          this.route = data;
        } catch (error) {
          console.error('[RouteStore] Error in standard applyShaping getRoute:', error);
          this.route = null;
        }
      } else {
        // Not enough points for a route, try hard route (which might clear it)
        await this.calculateHardRoute();
      }
      // Ensure dragged bearing is cleared if it wasn't used by sticky logic or if this path was taken
      this.clearDraggedShapingPointBearing();
    },

    async recalc(options: { forceGlobalOptimize?: boolean } = {}) {
      console.log(
        `[RouteStore] recalc CALLED - Options: ${JSON.stringify(options)}, ShapingPoints: ${this.shapingPoints.length}, DraggedSPId: ${JSON.stringify(
          this.draggedShapingPointInfo?.id
        )}`
      );
      this.isCalculatingGlobalRoute = true;

      if (options?.forceGlobalOptimize) {
        this.shapingPoints = [];
        this.clearDraggedShapingPointBearing();
        await this.calculateHardRoute();
      } else {
        const validWaypoints = this.waypoints.filter((wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0);
        if (validWaypoints.length < 2 && this.shapingPoints.length === 0) {
          this.route = null; // Not enough points for any route
          this.clearDraggedShapingPointBearing(); // Clear if recalc exits early
        } else if (this.shapingPoints.length > 0 || this.draggedShapingPointInfo) {
          // If there are shaping points OR an active sticky drag attempt, call applyShaping.
          await this.applyShaping();
        } else {
          // No shaping points and no active sticky drag, just calculate hard route
          await this.calculateHardRoute();
        }
      }

      this.isCalculatingGlobalRoute = false;
    },

    // --- Waypoint Management Actions ---
    async geocodeWaypoint(waypointId: string) {
      const waypoint = this.waypoints.find((wp) => wp.id === waypointId);
      if (!waypoint) return;
      if (
        waypoint.coords[0] === 0 &&
        waypoint.coords[1] === 0 &&
        (waypoint.address === 'Start Point' ||
          waypoint.address === 'End Point' ||
          waypoint.address === 'Via Point' ||
          !waypoint.address ||
          waypoint.address === 'New Via Point (Search or click map)')
      ) {
        waypoint.isGeocoding = false;
        if (waypoint.address && (!waypoint.userInput || waypoint.userInput === 'Loading address...')) {
          waypoint.userInput = waypoint.address; // Keep userInput in sync if address was just a placeholder
        }
        return;
      }

      waypoint.isGeocoding = true;
      const currentAddressDisplay = waypoint.address; // Keep current address in case geocoding fails
      waypoint.address = 'Loading address...';
      try {
        const place = await reverseGeocode(waypoint.coords);
        const newAddress = place?.label ?? 'Address not found';
        waypoint.address = newAddress;
        waypoint.userInput = newAddress; // Update userInput with geocoded result
        waypoint.kind = place?.kind || waypoint.kind;
      } catch (err) {
        console.error('[RouteStore] Geocode waypoint error:', err);
        waypoint.address = currentAddressDisplay !== 'Loading address...' && currentAddressDisplay ? currentAddressDisplay : 'Address lookup failed';
        // Keep userInput as it was if geocoding failed
      } finally {
        waypoint.isGeocoding = false;
      }
    },

    async addWaypointByClick(coord: Coord) {
      const startWp = this.waypoints.find((wp) => wp.kind === 'start');
      const endWp = this.waypoints.find((wp) => wp.kind === 'end');
      let waypointToUpdateId: string | undefined;

      if (startWp && startWp.coords[0] === 0 && startWp.coords[1] === 0) {
        startWp.coords = coord;
        startWp.userInput = 'Loading address...';
        waypointToUpdateId = startWp.id;
      } else if (endWp && endWp.coords[0] === 0 && endWp.coords[1] === 0) {
        endWp.coords = coord;
        endWp.userInput = 'Loading address...';
        waypointToUpdateId = endWp.id;
      } else {
        const newWp = this._addWaypointInternal(coord, 'via', 'Loading address...', '');
        const endIndex = this.waypoints.findIndex((wp) => wp.kind === 'end');
        if (endIndex !== -1) {
          this.waypoints.splice(endIndex, 0, newWp);
        } else {
          this.waypoints.push(newWp);
        }
        waypointToUpdateId = newWp.id;
      }
      if (waypointToUpdateId) {
        await this.geocodeWaypoint(waypointToUpdateId);
      }
    },

    async addPlaceAsWaypoint(place: Place) {
      const startWp = this.waypoints.find((wp) => wp.kind === 'start');
      const endWp = this.waypoints.find((wp) => wp.kind === 'end');

      const newWpData = {
        coords: place.coord,
        address: place.label,
        isGeocoding: false,
        kind: place.kind || 'poi', // Default kind if place.kind is empty
        userInput: place.label,
      };

      if (startWp && startWp.coords[0] === 0 && startWp.coords[1] === 0 && startWp.address === 'Start Point') {
        Object.assign(startWp, { ...newWpData, kind: 'start' });
      } else if (endWp && endWp.coords[0] === 0 && endWp.coords[1] === 0 && endWp.address === 'End Point') {
        Object.assign(endWp, { ...newWpData, kind: 'end' });
      } else {
        const createdWp = this._addWaypointInternal(place.coord, place.kind || 'poi', place.label, place.label);
        const endIndex = this.waypoints.findIndex((w) => w.kind === 'end');
        if (endIndex !== -1) {
          this.waypoints.splice(endIndex, 0, createdWp);
        } else {
          this.waypoints.push(createdWp);
        }
      }
    },

    async insertWaypointOnRoute(indexAfterSegment: number, coord: Coord) {
      // indexAfterSegment is 0-based index of the segment clicked.
      // New waypoint should be inserted after the waypoint that starts this segment.
      // So, if segment 0 (between WP0 and WP1) is clicked, new WP is after WP0 (at index 1).
      const insertionIndexInWaypoints = indexAfterSegment + 1;
      const newWp = this._addWaypointInternal(coord, 'via', 'Loading address...', '');
      this.waypoints.splice(insertionIndexInWaypoints, 0, newWp);

      // When inserting a hard waypoint on the route, clear shaping points as they are now invalid.
      if (this.shapingPoints.length > 0) {
        console.log('[RouteStore] Clearing shaping points due to hard waypoint insertion on route.');
        this.shapingPoints = [];
        this.clearDraggedShapingPointBearing();
      }
      await this.geocodeWaypoint(newWp.id);
    },

    async insertShapingPoint(originalSegmentIdxPlusOne: number, coord: Coord, radius: number) {
      const newId = newShapePointId();
      // originalSegmentIdxPlusOne is 1-based index of the waypoint it logically follows (segment it's part of)
      this.shapingPoints.push({ id: newId, idx: originalSegmentIdxPlusOne, coord, radius });
      this.shapingPoints.sort((a, b) => a.idx - b.idx);
    },

    async updateShapingPointCoord(id: string, newCoords: Coord, radius: number) {
      const point = this.shapingPoints.find((sp) => sp.id === id);
      if (point) {
        point.coord = newCoords;
        point.radius = radius;
        // Recalc will be triggered by watcher, and applyShaping will use draggedShapingPointInfo.
      } else {
        // If point not found, clear dragged bearing if it was for this ID
        if (this.draggedShapingPointInfo && this.draggedShapingPointInfo.id === id) {
          this.clearDraggedShapingPointBearing();
        }
      }
    },

    async updateWaypointCoord(waypointId: string, newCoords: Coord) {
      const waypoint = this.waypoints.find((wp) => wp.id === waypointId);
      if (!waypoint) return;
      waypoint.coords = newCoords;
      waypoint.userInput = 'Loading address...';

      if (this.shapingPoints.length > 0) {
        console.log('[RouteStore] Clearing shaping points due to hard waypoint coordinate update.');
        this.shapingPoints = [];
      }
      this.clearDraggedShapingPointBearing();

      await this.geocodeWaypoint(waypointId);
    },

    async removeWaypoint(waypointId: string) {
      const index = this.waypoints.findIndex((wp) => wp.id === waypointId);
      if (index === -1) return;

      const waypointBeingRemoved = this.waypoints[index];
      const isStartOrEndBeingReset = this.waypoints.length <= 2 && (waypointBeingRemoved.kind === 'start' || waypointBeingRemoved.kind === 'end');

      if (this.waypoints.length <= 2 && isStartOrEndBeingReset) {
        // Reset the waypoint instead of removing if it's one of the two mandatory ones
        waypointBeingRemoved.coords = [0, 0];
        const placeholderAddress = waypointBeingRemoved.kind === 'start' ? 'Start Point' : 'End Point';
        waypointBeingRemoved.address = placeholderAddress;
        waypointBeingRemoved.userInput = placeholderAddress; // Reset userInput
        waypointBeingRemoved.isGeocoding = false;
      } else {
        this.waypoints.splice(index, 1);
        // Ensure there's always a start and end if waypoints remain
        if (this.waypoints.length > 0 && !this.waypoints.find((wp) => wp.kind === 'start')) {
          this.waypoints[0].kind = 'start';
        }
        if (this.waypoints.length > 0 && !this.waypoints.find((wp) => wp.kind === 'end')) {
          this.waypoints[this.waypoints.length - 1].kind = 'end';
        }
      }

      // Removing a hard waypoint should invalidate and clear shaping points.
      if (this.shapingPoints.length > 0) {
        console.log('[RouteStore] Clearing shaping points due to hard waypoint removal/reset.');
        this.shapingPoints = [];
      }
      this.clearDraggedShapingPointBearing();
    },

    async clearShaping() {
      if (this.shapingPoints.length > 0) {
        this.shapingPoints = [];
      }
      this.clearDraggedShapingPointBearing();
      // Recalc will be triggered, will likely call calculateHardRoute
    },

    async optimizeEntireRoute() {
      await this.recalc({ forceGlobalOptimize: true });
    },
  },
});

// This function might not be strictly necessary if service functions always return OrsFeatureCollection
// and the store's this.route is typed as OrsFeatureCollection.
// However, it can be a safeguard or place for further transformation if needed.
function orsToFeatureCollection(orsData: OrsFeatureCollection | any): OrsFeatureCollection {
  if (!orsData) {
    console.warn('[RouteStore] orsToFeatureCollection received null/undefined data.');
    return { type: 'FeatureCollection', features: [] } as OrsFeatureCollection;
  }
  if (orsData.type === 'FeatureCollection' && Array.isArray(orsData.features)) {
    return orsData as OrsFeatureCollection;
  }
  console.warn('[RouteStore] orsToFeatureCollection: Data not in expected OrsFeatureCollection format:', JSON.stringify(orsData).substring(0, 300) + '...');
  return { type: 'FeatureCollection', features: [] } as OrsFeatureCollection; // Fallback
}

export type RouteStore = ReturnType<typeof useRouteStore>;

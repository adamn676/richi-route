// src/stores/route.store.ts
import { defineStore } from 'pinia';
import type { FeatureCollection as GeoJSONFeatureCollection, GeoJsonProperties } from 'geojson';
import { getRoute, getRouteWithStickyShaping, type BearingValue, type Coord } from '@/services/route.service';
import type { OrsFeatureCollection } from '@/types';
import { reverseGeocode, type Place, forwardGeocode } from '@/services/maptiler.service';
import { DEFAULT_WAYPOINT_ORS_RADIUS } from '@/config/map.config';
import { useDebugStore, type DebugRadiusVisualization, type DebugBearingVisualization } from '@/stores/debug.store';

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
      { id: newWaypointId(), coords: [0, 0] as Coord, address: 'Start Point', isGeocoding: false, kind: 'start', userInput: '' },
      { id: newWaypointId(), coords: [0, 0] as Coord, address: 'End Point', isGeocoding: false, kind: 'end', userInput: '' },
    ] as Waypoint[],
    shapingPoints: [] as ShapePoint[],
    route: null as OrsFeatureCollection | null,
    isCalculatingGlobalRoute: false,
    draggedShapingPointInfo: null as { id: string; bearing: [number, number] } | null,
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

    // START: ADD THIS METHOD BACK
    async addWaypointByClick(coord: Coord) {
      console.log('[RouteStore] addWaypointByClick called with:', coord);
      const startWp = this.waypoints.find((wp) => wp.kind === 'start');
      const endWp = this.waypoints.find((wp) => wp.kind === 'end');

      let targetWaypointId: string | null = null;

      // Ensure startWp and endWp are the first two waypoints if they exist with [0,0]
      // This logic assumes start is waypoints[0] and end is waypoints[1] for initial [0,0] checks
      const initialStartWp = this.waypoints[0];
      const initialEndWp = this.waypoints[1];

      if (initialStartWp && initialStartWp.kind === 'start' && initialStartWp.coords[0] === 0 && initialStartWp.coords[1] === 0) {
        console.log('[RouteStore] addWaypointByClick - Updating Start waypoint.');
        initialStartWp.coords = coord;
        targetWaypointId = initialStartWp.id;
      } else if (initialEndWp && initialEndWp.kind === 'end' && initialEndWp.coords[0] === 0 && initialEndWp.coords[1] === 0 && this.waypoints.length === 2) {
        // Only update end if it's the second default point and still [0,0]
        console.log('[RouteStore] addWaypointByClick - Updating End waypoint.');
        initialEndWp.coords = coord;
        targetWaypointId = initialEndWp.id;
      } else {
        console.log('[RouteStore] addWaypointByClick - Adding new Via waypoint.');
        const newWp = this._addWaypointInternal(coord, 'via', 'Loading address...', '');
        const endIndex = this.waypoints.findIndex((wp) => wp.kind === 'end');
        if (endIndex !== -1) {
          this.waypoints.splice(endIndex, 0, newWp);
        } else {
          // Fallback if no 'end' waypoint, though this should ideally not happen with default setup
          this.waypoints.push(newWp);
        }
        targetWaypointId = newWp.id;
      }

      if (targetWaypointId) {
        await this.geocodeWaypoint(targetWaypointId);
      }
      // Recalculation is handled by the watcher on waypoints
    },
    // END: ADD THIS METHOD BACK

    async addIntermediateStopAndPrepare() {
      const newWp = this._addWaypointInternal([0, 0] as Coord, 'via', 'New Via Point (Search or click map)', ''); // Added "as Coord"
      const endIndex = this.waypoints.findIndex((wp) => wp.kind === 'end');
      if (endIndex !== -1) {
        this.waypoints.splice(endIndex, 0, newWp);
      } else {
        this.waypoints.push(newWp);
      }
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
          waypoint.userInput = firstPlace.label; // Keep userInput in sync with selected address
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
    },

    _updateDebugVisuals(
      pointsForOrs: { coords: Coord; radius: number; type: 'waypoint' | 'shaping_point'; id: string }[],
      bearingsForOrs: (BearingValue | null)[],
      requestPayload: any
    ) {
      const debugStore = useDebugStore();
      if (!debugStore.showDebugVisuals) return;

      const radiusVisuals: DebugRadiusVisualization[] = pointsForOrs.map((p) => ({
        id: p.id,
        center: p.coords,
        radius: p.radius,
        type: p.type,
      }));
      debugStore.updateRadiusVisuals(radiusVisuals);

      const bearingVisuals: DebugBearingVisualization[] = [];
      pointsForOrs.forEach((p, index) => {
        const bearingInfo = bearingsForOrs[index];
        if (Array.isArray(bearingInfo) && bearingInfo.length === 2 && typeof bearingInfo[0] === 'number' && typeof bearingInfo[1] === 'number') {
          bearingVisuals.push({
            id: p.id + '_bearing',
            origin: p.coords,
            bearing: bearingInfo[0],
            tolerance: bearingInfo[1],
            length: 50, // Default length in meters
          });
        }
      });
      debugStore.updateBearingVisuals(bearingVisuals);
      debugStore.setLastOrsRequestPayload(requestPayload);
    },

    async calculateHardRoute() {
      console.log('[RouteStore] calculateHardRoute CALLED');
      const debugStore = useDebugStore();

      if (this.waypoints.length < 2) {
        this.route = null;
        debugStore.clearVisuals();
        return;
      }
      const validWaypoints = this.waypoints.filter((wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0);
      if (validWaypoints.length < 2) {
        this.route = null;
        debugStore.clearVisuals();
        return;
      }

      const coords = validWaypoints.map((wp) => wp.coords);
      const radiuses = validWaypoints.map(() => DEFAULT_WAYPOINT_ORS_RADIUS); // All hard waypoints get default radius
      const bearings = validWaypoints.map(() => null as BearingValue); // Bearings for hard waypoints usually null unless specific constraints are needed

      const pointsForDebug = validWaypoints.map((wp) => ({
        coords: wp.coords,
        radius: DEFAULT_WAYPOINT_ORS_RADIUS,
        type: 'waypoint' as 'waypoint' | 'shaping_point',
        id: wp.id,
      }));
      const orsRequestPayload = { coordinates: coords, radiuses, bearings, profile: 'cycling-regular', instructions: false };
      this._updateDebugVisuals(pointsForDebug, bearings, orsRequestPayload);

      console.log('[RouteStore] calculateHardRoute - Coords:', coords.length, 'Radiuses:', radiuses.length, 'Bearings (raw for getRoute):', bearings.length);
      try {
        const data = await getRoute(coords, radiuses, bearings);
        this.route = data;
        if (debugStore.showDebugVisuals) debugStore.setLastOrsResponse(data);
      } catch (error) {
        console.error('[RouteStore] Error in calculateHardRoute getRoute:', error);
        this.route = null;
        if (debugStore.showDebugVisuals) debugStore.setLastOrsResponse({ error: String(error) });
        // debugStore.clearVisuals(); // Clearing visuals might be too aggressive here, maybe only on full failure.
      }
    },

    _buildFullPointListForSingleCall(): {
      coords: Coord[];
      radiuses: number[];
      bearings: BearingValue[];
      debugPoints: { coords: Coord; radius: number; type: 'waypoint' | 'shaping_point'; id: string }[];
    } | null {
      const validWaypoints = this.waypoints.filter((wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0);
      if (validWaypoints.length < 2) {
        return null;
      }

      const sortedShapingPoints = [...this.shapingPoints].sort((a, b) => a.idx - b.idx);

      const finalCoordsForORS: Coord[] = [];
      const finalRadiusesForORS: number[] = [];
      const finalBearingsForORS: BearingValue[] = [];
      const finalDebugPoints: { coords: Coord; radius: number; type: 'waypoint' | 'shaping_point'; id: string }[] = [];

      let currentShapingPointProcessingIdx = 0;
      for (let i = 0; i < validWaypoints.length; i++) {
        finalCoordsForORS.push(validWaypoints[i].coords);
        finalRadiusesForORS.push(DEFAULT_WAYPOINT_ORS_RADIUS); // Hard waypoints get default radius
        finalBearingsForORS.push(null); // Default bearing for hard waypoints unless specifically set
        finalDebugPoints.push({ coords: validWaypoints[i].coords, radius: DEFAULT_WAYPOINT_ORS_RADIUS, type: 'waypoint', id: validWaypoints[i].id });

        if (i < validWaypoints.length - 1) {
          const targetSegmentOriginalIndex = i;
          while (
            currentShapingPointProcessingIdx < sortedShapingPoints.length &&
            sortedShapingPoints[currentShapingPointProcessingIdx].idx === targetSegmentOriginalIndex + 1
          ) {
            const sp = sortedShapingPoints[currentShapingPointProcessingIdx];
            finalCoordsForORS.push(sp.coord);
            finalRadiusesForORS.push(sp.radius); // Shaping points use their own stored radius
            finalDebugPoints.push({ coords: sp.coord, radius: sp.radius, type: 'shaping_point', id: sp.id });

            if (this.draggedShapingPointInfo && this.draggedShapingPointInfo.id === sp.id) {
              finalBearingsForORS.push(this.draggedShapingPointInfo.bearing as BearingValue);
            } else {
              finalBearingsForORS.push(null); // Default bearing for shaping points if not being dragged with a constraint
            }
            currentShapingPointProcessingIdx++;
          }
        }
      }

      if (finalCoordsForORS.length < 2) return null;
      // console.log('[RouteStore] _buildFullPointListForSingleCall - Final Radiuses:', finalRadiusesForORS);
      return { coords: finalCoordsForORS, radiuses: finalRadiusesForORS, bearings: finalBearingsForORS, debugPoints: finalDebugPoints };
    },

    async applyShaping() {
      // console.log('[RouteStore] applyShaping CALLED. Active Dragged SP Info:', JSON.stringify(this.draggedShapingPointInfo));
      const debugStore = useDebugStore();

      const validWaypoints = this.waypoints.filter((wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0);
      if (validWaypoints.length < 2) {
        this.route = null;
        this.clearDraggedShapingPointBearing();
        debugStore.clearVisuals();
        return;
      }

      if (this.draggedShapingPointInfo && this.shapingPoints.length > 0) {
        const activeSp = this.shapingPoints.find((sp) => sp.id === this.draggedShapingPointInfo!.id);

        if (activeSp && validWaypoints.length === 2 && this.shapingPoints.length === 1 && this.shapingPoints[0].id === activeSp.id) {
          const startWp = validWaypoints[0];
          const endWp = validWaypoints[1];
          const spSimpleBearing = this.draggedShapingPointInfo.bearing;

          const debugPointsForSticky: { coords: Coord; radius: number; type: 'waypoint' | 'shaping_point'; id: string }[] = [
            { coords: startWp.coords, radius: DEFAULT_WAYPOINT_ORS_RADIUS, type: 'waypoint', id: startWp.id },
            { coords: activeSp.coord, radius: activeSp.radius, type: 'shaping_point', id: activeSp.id },
            { coords: endWp.coords, radius: DEFAULT_WAYPOINT_ORS_RADIUS, type: 'waypoint', id: endWp.id },
          ];
          const bearingsForStickyDebug: (BearingValue | null)[] = [null, spSimpleBearing, null];

          const orsRequestPayload = {
            startCoord: startWp.coords,
            shapingCoord: activeSp.coord,
            endCoord: endWp.coords,
            shapingBearing: spSimpleBearing,
            startRadius: DEFAULT_WAYPOINT_ORS_RADIUS,
            shapingRadius: activeSp.radius, // Use the shaping point's actual radius
            endRadius: DEFAULT_WAYPOINT_ORS_RADIUS,
          };
          this._updateDebugVisuals(debugPointsForSticky, bearingsForStickyDebug, orsRequestPayload);

          console.log(
            `[RouteStore] Attempting STICKY SHAPING for SP ${activeSp.id} between ${startWp.id} and ${endWp.id} with bearing ${JSON.stringify(
              spSimpleBearing
            )} and radius ${activeSp.radius}`
          );
          try {
            const data = await getRouteWithStickyShaping(
              startWp.coords,
              activeSp.coord,
              endWp.coords,
              spSimpleBearing, // This is SimpleBearing [angle, tolerance]
              DEFAULT_WAYPOINT_ORS_RADIUS, // startRadius for ORS
              activeSp.radius, // shapingRadius for ORS
              DEFAULT_WAYPOINT_ORS_RADIUS // endRadius for ORS
            );
            this.route = data;
            if (debugStore.showDebugVisuals) debugStore.setLastOrsResponse(data);
          } catch (error) {
            console.error('[RouteStore] Error in STICKY applyShaping:', error);
            if (debugStore.showDebugVisuals) debugStore.setLastOrsResponse({ error: String(error) });
            // debugStore.clearVisuals(); // Potential fallback might repopulate
            const pointList = this._buildFullPointListForSingleCall(); // Fallback to standard shaping
            if (pointList) {
              const fallbackOrsRequest = {
                coordinates: pointList.coords,
                radiuses: pointList.radiuses,
                bearings: pointList.bearings,
                profile: 'cycling-regular',
                instructions: false,
              };
              this._updateDebugVisuals(pointList.debugPoints, pointList.bearings, fallbackOrsRequest); // Update debug for fallback
              try {
                this.route = await getRoute(pointList.coords, pointList.radiuses, pointList.bearings);
                if (debugStore.showDebugVisuals) debugStore.setLastOrsResponse(this.route);
              } catch (fallbackError) {
                console.error('[RouteStore] Error in STICKY fallback getRoute:', fallbackError);
                this.route = null; // Set route to null on fallback error
                if (debugStore.showDebugVisuals) debugStore.setLastOrsResponse({ error: String(fallbackError) });
                debugStore.clearVisuals(); // Clear visuals on final failure
              }
            } else {
              this.route = null; // No points for fallback
              debugStore.clearVisuals();
            }
          } finally {
            this.clearDraggedShapingPointBearing();
          }
          return; // Exit after handling sticky shaping
        } else if (activeSp) {
          // console.warn(
          //   `[RouteStore] Sticky shaping for SP ${activeSp.id} in a more complex route (multiple WPs/SPs) is not yet implemented. Falling back to standard shaping.`
          // );
        }
      }

      // console.log('[RouteStore] Proceeding with standard shaping (single call).');
      const pointList = this._buildFullPointListForSingleCall();
      if (pointList) {
        const orsRequestPayload = {
          coordinates: pointList.coords,
          radiuses: pointList.radiuses,
          bearings: pointList.bearings, // Bearings from _buildFullPointListForSingleCall
          profile: 'cycling-regular',
          instructions: false,
        };
        this._updateDebugVisuals(pointList.debugPoints, pointList.bearings, orsRequestPayload);
        try {
          const data = await getRoute(pointList.coords, pointList.radiuses, pointList.bearings);
          this.route = data;
          if (debugStore.showDebugVisuals) debugStore.setLastOrsResponse(data);
        } catch (error) {
          console.error('[RouteStore] Error in standard applyShaping getRoute:', error);
          this.route = null;
          if (debugStore.showDebugVisuals) debugStore.setLastOrsResponse({ error: String(error) });
          debugStore.clearVisuals();
        }
      } else {
        // No valid points for standard shaping, might need to just use hard route or clear
        await this.calculateHardRoute(); // Or simply set route to null if no valid waypoints
      }
      this.clearDraggedShapingPointBearing(); // Ensure this is cleared if not handled by sticky
    },

    async recalc(options: { forceGlobalOptimize?: boolean } = {}) {
      // console.log(
      //   `[RouteStore] recalc CALLED - Options: ${JSON.stringify(options)}, ShapingPoints: ${this.shapingPoints.length}, DraggedSPId: ${JSON.stringify(
      //     this.draggedShapingPointInfo?.id
      //   )}`
      // );
      this.isCalculatingGlobalRoute = true;
      const debugStore = useDebugStore();

      if (options?.forceGlobalOptimize) {
        this.shapingPoints = []; // Clear shaping points
        this.clearDraggedShapingPointBearing(); // Clear any dragged info
        // debugStore.clearVisuals(); // Visuals will be updated by calculateHardRoute
        await this.calculateHardRoute();
      } else {
        const validWaypoints = this.waypoints.filter((wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0);
        if (validWaypoints.length < 2 && this.shapingPoints.length === 0) {
          this.route = null;
          this.clearDraggedShapingPointBearing();
          debugStore.clearVisuals();
        } else if (this.shapingPoints.length > 0 || this.draggedShapingPointInfo) {
          await this.applyShaping();
        } else {
          await this.calculateHardRoute();
        }
      }
      this.isCalculatingGlobalRoute = false;
    },

    async geocodeWaypoint(waypointId: string) {
      const waypoint = this.waypoints.find((wp) => wp.id === waypointId);
      if (!waypoint) return;

      // Avoid geocoding if it's a default placeholder
      if (
        waypoint.coords[0] === 0 &&
        waypoint.coords[1] === 0 &&
        (waypoint.address === 'Start Point' ||
          waypoint.address === 'End Point' ||
          waypoint.address === 'Via Point' || // Covers case where it's added but not yet geocoded by click
          !waypoint.address || // Covers null or empty string
          waypoint.address === 'New Via Point (Search or click map)') &&
        (!waypoint.userInput || waypoint.userInput === 'Loading address...' || waypoint.userInput === waypoint.address) // also check userInput
      ) {
        waypoint.isGeocoding = false;
        // Ensure userInput reflects placeholder if it was 'Loading address...'
        if (waypoint.address && (waypoint.userInput === 'Loading address...' || !waypoint.userInput)) {
          waypoint.userInput = waypoint.address;
        }
        return;
      }

      waypoint.isGeocoding = true;
      const currentAddressDisplay = waypoint.address; // Store current address in case geocoding fails
      waypoint.address = 'Loading address...'; // Visual feedback
      // waypoint.userInput = 'Loading address...'; // Update userInput as well

      try {
        const place = await reverseGeocode(waypoint.coords);
        const newAddress = place?.label ?? 'Address not found';
        waypoint.address = newAddress;
        waypoint.userInput = newAddress; // Keep userInput in sync
        waypoint.kind = place?.kind || waypoint.kind; // Update kind if available
      } catch (err) {
        console.error('[RouteStore] Geocode waypoint error:', err);
        // Revert to previous address if not 'Loading address...', otherwise indicate failure
        waypoint.address = currentAddressDisplay && currentAddressDisplay !== 'Loading address...' ? currentAddressDisplay : 'Address lookup failed';
        if (!waypoint.userInput || waypoint.userInput === 'Loading address...') {
          // also revert userInput if it was placeholder
          waypoint.userInput = waypoint.address;
        }
      } finally {
        waypoint.isGeocoding = false;
      }
    },

    async insertShapingPoint(originalSegmentIdxPlusOne: number, coord: Coord, radius: number) {
      const newId = newShapePointId();
      this.shapingPoints.push({ id: newId, idx: originalSegmentIdxPlusOne, coord, radius });
      this.shapingPoints.sort((a, b) => a.idx - b.idx); // Ensure order for _buildFullPointListForSingleCall
    },

    async updateShapingPointCoord(id: string, newCoords: Coord, radius: number) {
      const point = this.shapingPoints.find((sp) => sp.id === id);
      if (point) {
        point.coord = newCoords;
        point.radius = radius; // Update radius as well
      } else {
        // If the point was somehow removed (e.g., during a rapid drag/clear operation)
        // ensure draggedShapingPointInfo is cleared if it matches.
        if (this.draggedShapingPointInfo && this.draggedShapingPointInfo.id === id) {
          this.clearDraggedShapingPointBearing();
        }
      }
    },

    async updateWaypointCoord(waypointId: string, newCoords: Coord) {
      const waypoint = this.waypoints.find((wp) => wp.id === waypointId);
      if (!waypoint) return;
      waypoint.coords = newCoords;
      // waypoint.address = 'Loading address...'; // Set to loading for immediate feedback
      waypoint.userInput = 'Loading address...'; // Also update userInput to show loading

      // As per prompt: "clears all shapingPoints"
      if (this.shapingPoints.length > 0) {
        console.log('[RouteStore] updateWaypointCoord: Clearing shaping points due to hard waypoint drag.');
        this.shapingPoints = [];
        this.clearDraggedShapingPointBearing(); // Clear any bearing constraints tied to shaping
        useDebugStore().clearVisuals(); // Clear debug visuals as shaping points are gone
      }

      await this.geocodeWaypoint(waypointId);
      // Recalculation is handled by the watcher
    },

    async insertWaypointOnRoute(segmentIndexClicked: number, coord: Coord) {
      // segmentIndexClicked is 0-based index of the segment (e.g., click on segment between WP0 and WP1 means segmentIndexClicked = 0)
      // New waypoint should be inserted AFTER the waypoint that starts the clicked segment.
      // So, insertion index in waypoints array is segmentIndexClicked + 1.
      const insertionIndexInWaypoints = segmentIndexClicked + 1;

      const newWp = this._addWaypointInternal(coord, 'via', 'Loading address...', '');
      this.waypoints.splice(insertionIndexInWaypoints, 0, newWp);

      // When a hard waypoint is inserted on the route, it invalidates existing shaping.
      if (this.shapingPoints.length > 0) {
        console.log('[RouteStore] Clearing shaping points due to hard waypoint insertion on route.');
        this.shapingPoints = [];
        this.clearDraggedShapingPointBearing();
        useDebugStore().clearVisuals(); // Shaping related visuals are now invalid
      }
      await this.geocodeWaypoint(newWp.id);
      // Recalculation is handled by the watcher
    },

    async removeWaypoint(waypointId: string) {
      const index = this.waypoints.findIndex((wp) => wp.id === waypointId);
      if (index === -1) return;

      const waypointBeingRemoved = this.waypoints[index];
      const isStartOrEnd = waypointBeingRemoved.kind === 'start' || waypointBeingRemoved.kind === 'end';
      const allowReset = this.waypoints.length <= 2 && isStartOrEnd;

      if (allowReset) {
        // Reset Start/End to [0,0] instead of removing if only 1 or 2 waypoints exist
        waypointBeingRemoved.coords = [0, 0] as Coord; // Added "as Coord"
        const placeholderAddress = waypointBeingRemoved.kind === 'start' ? 'Start Point' : 'End Point';
        waypointBeingRemoved.address = placeholderAddress;
        waypointBeingRemoved.userInput = placeholderAddress;
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

      // Removing a hard waypoint invalidates shaping
      if (this.shapingPoints.length > 0) {
        console.log('[RouteStore] Clearing shaping points due to hard waypoint removal/reset.');
        this.shapingPoints = [];
        useDebugStore().clearVisuals(); // Shaping related visuals are now invalid
      }
      this.clearDraggedShapingPointBearing(); // Also clear any dragged bearing info
      // Recalculation is handled by the watcher
    },

    async clearShaping() {
      if (this.shapingPoints.length > 0) {
        this.shapingPoints = [];
      }
      this.clearDraggedShapingPointBearing();
      // Don't clear all debug visuals, just shaping related ones.
      // This can be refined, but for now, recalc will handle updating visuals based on current state.
      // useDebugStore().clearVisuals(); // This might be too broad.
      // Let recalc handle it. If no shaping points, applyShaping won't run or won't add visuals.
      await this.recalc(); // Trigger a recalc to get route without shaping
    },

    async optimizeEntireRoute() {
      await this.recalc({ forceGlobalOptimize: true });
    },
  },
});

export type RouteStore = ReturnType<typeof useRouteStore>;

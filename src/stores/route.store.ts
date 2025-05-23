// src/stores/route.store.ts
import { defineStore } from 'pinia';
import type { FeatureCollection as GeoJSONFeatureCollection, GeoJsonProperties } from 'geojson';
import { getRoute, getRouteWithStickyShaping, type BearingValue, type Coord } from '@/services/route.service';
import type { OrsFeatureCollection } from '@/types';
import { reverseGeocode, type Place, forwardGeocode } from '@/services/maptiler.service';
import { DEFAULT_WAYPOINT_ORS_RADIUS } from '@/config/map.config';
// Import the debug store and its types
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

    async addIntermediateStopAndPrepare() {
      const newWp = this._addWaypointInternal([0, 0], 'via', 'New Via Point (Search or click map)', '');
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
          waypoint.userInput = firstPlace.label;
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
        // --- START OF CORRECTION ---
        // Check if bearingInfo is specifically a SimpleBearing: [number, number]
        if (
          Array.isArray(bearingInfo) &&
          bearingInfo.length === 2 &&
          typeof bearingInfo[0] === 'number' && // This ensures bearingInfo[0] is a number
          typeof bearingInfo[1] === 'number' // This ensures bearingInfo[1] is a number
        ) {
          // At this point, TypeScript knows bearingInfo is [number, number]
          bearingVisuals.push({
            id: p.id + '_bearing',
            origin: p.coords,
            bearing: bearingInfo[0], // Now correctly typed as number
            tolerance: bearingInfo[1], // Now correctly typed as number
            length: 50,
          });
        }
        // --- END OF CORRECTION ---
        // Optionally, you could add an `else if` here to handle the complex
        // bearing type `[[number, number], [number, number]]` if you ever intend
        // to visualize that differently (e.g., visualizing only the approach bearing).
        // For now, this will only visualize SimpleBearings.
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
      const radiuses = validWaypoints.map(() => DEFAULT_WAYPOINT_ORS_RADIUS);
      const bearings = validWaypoints.map(() => null as BearingValue);

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
        debugStore.clearVisuals();
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
        finalRadiusesForORS.push(DEFAULT_WAYPOINT_ORS_RADIUS);
        finalBearingsForORS.push(null);
        finalDebugPoints.push({ coords: validWaypoints[i].coords, radius: DEFAULT_WAYPOINT_ORS_RADIUS, type: 'waypoint', id: validWaypoints[i].id });

        if (i < validWaypoints.length - 1) {
          const targetSegmentOriginalIndex = i;
          while (
            currentShapingPointProcessingIdx < sortedShapingPoints.length &&
            sortedShapingPoints[currentShapingPointProcessingIdx].idx === targetSegmentOriginalIndex + 1
          ) {
            const sp = sortedShapingPoints[currentShapingPointProcessingIdx];
            finalCoordsForORS.push(sp.coord);
            finalRadiusesForORS.push(sp.radius);
            finalDebugPoints.push({ coords: sp.coord, radius: sp.radius, type: 'shaping_point', id: sp.id });

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
      console.log('[RouteStore] _buildFullPointListForSingleCall - Final Radiuses:', finalRadiusesForORS);
      return { coords: finalCoordsForORS, radiuses: finalRadiusesForORS, bearings: finalBearingsForORS, debugPoints: finalDebugPoints };
    },

    async applyShaping() {
      console.log('[RouteStore] applyShaping CALLED. Active Dragged SP Info:', JSON.stringify(this.draggedShapingPointInfo));
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
            shapingRadius: activeSp.radius,
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
              spSimpleBearing,
              DEFAULT_WAYPOINT_ORS_RADIUS,
              activeSp.radius,
              DEFAULT_WAYPOINT_ORS_RADIUS
            );
            this.route = data;
            if (debugStore.showDebugVisuals) debugStore.setLastOrsResponse(data);
          } catch (error) {
            console.error('[RouteStore] Error in STICKY applyShaping:', error);
            if (debugStore.showDebugVisuals) debugStore.setLastOrsResponse({ error: String(error) });
            debugStore.clearVisuals();
            const pointList = this._buildFullPointListForSingleCall();
            if (pointList) {
              const fallbackOrsRequest = {
                coordinates: pointList.coords,
                radiuses: pointList.radiuses,
                bearings: pointList.bearings,
                profile: 'cycling-regular',
                instructions: false,
              };
              this._updateDebugVisuals(pointList.debugPoints, pointList.bearings, fallbackOrsRequest);
              this.route = await getRoute(pointList.coords, pointList.radiuses, pointList.bearings);
              if (debugStore.showDebugVisuals) debugStore.setLastOrsResponse(this.route);
            } else {
              this.route = null;
            }
          } finally {
            this.clearDraggedShapingPointBearing();
          }
          return;
        } else if (activeSp) {
          console.warn(
            `[RouteStore] Sticky shaping for SP ${activeSp.id} in a more complex route (multiple WPs/SPs) is not yet implemented. Falling back to standard shaping.`
          );
        }
      }

      console.log('[RouteStore] Proceeding with standard shaping (single call).');
      const pointList = this._buildFullPointListForSingleCall();
      if (pointList) {
        const orsRequestPayload = {
          coordinates: pointList.coords,
          radiuses: pointList.radiuses,
          bearings: pointList.bearings,
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
        await this.calculateHardRoute();
      }
      this.clearDraggedShapingPointBearing();
    },

    async recalc(options: { forceGlobalOptimize?: boolean } = {}) {
      console.log(
        `[RouteStore] recalc CALLED - Options: ${JSON.stringify(options)}, ShapingPoints: ${this.shapingPoints.length}, DraggedSPId: ${JSON.stringify(
          this.draggedShapingPointInfo?.id
        )}`
      );
      this.isCalculatingGlobalRoute = true;
      const debugStore = useDebugStore();

      if (options?.forceGlobalOptimize) {
        this.shapingPoints = [];
        this.clearDraggedShapingPointBearing();
        debugStore.clearVisuals();
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
          waypoint.userInput = waypoint.address;
        }
        return;
      }

      waypoint.isGeocoding = true;
      const currentAddressDisplay = waypoint.address;
      waypoint.address = 'Loading address...';
      try {
        const place = await reverseGeocode(waypoint.coords);
        const newAddress = place?.label ?? 'Address not found';
        waypoint.address = newAddress;
        waypoint.userInput = newAddress;
        waypoint.kind = place?.kind || waypoint.kind;
      } catch (err) {
        console.error('[RouteStore] Geocode waypoint error:', err);
        waypoint.address = currentAddressDisplay !== 'Loading address...' && currentAddressDisplay ? currentAddressDisplay : 'Address lookup failed';
      } finally {
        waypoint.isGeocoding = false;
      }
    },
    async insertShapingPoint(originalSegmentIdxPlusOne: number, coord: Coord, radius: number) {
      const newId = newShapePointId();
      this.shapingPoints.push({ id: newId, idx: originalSegmentIdxPlusOne, coord, radius });
      this.shapingPoints.sort((a, b) => a.idx - b.idx);
    },

    async updateShapingPointCoord(id: string, newCoords: Coord, radius: number) {
      const point = this.shapingPoints.find((sp) => sp.id === id);
      if (point) {
        point.coord = newCoords;
        point.radius = radius;
      } else {
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

      console.log(
        '[RouteStore] updateWaypointCoord: Shaping points will NOT be cleared. Manual optimization or next recalc might be needed if route shape is unusual.'
      );

      await this.geocodeWaypoint(waypointId);
    },
    async insertWaypointOnRoute(indexAfterSegment: number, coord: Coord) {
      const insertionIndexInWaypoints = indexAfterSegment + 1;
      const newWp = this._addWaypointInternal(coord, 'via', 'Loading address...', '');
      this.waypoints.splice(insertionIndexInWaypoints, 0, newWp);

      if (this.shapingPoints.length > 0) {
        console.log('[RouteStore] Clearing shaping points due to hard waypoint insertion on route.');
        this.shapingPoints = [];
        this.clearDraggedShapingPointBearing();
        useDebugStore().clearVisuals();
      }
      await this.geocodeWaypoint(newWp.id);
    },
    async removeWaypoint(waypointId: string) {
      const index = this.waypoints.findIndex((wp) => wp.id === waypointId);
      if (index === -1) return;

      const waypointBeingRemoved = this.waypoints[index];
      const isStartOrEndBeingReset = this.waypoints.length <= 2 && (waypointBeingRemoved.kind === 'start' || waypointBeingRemoved.kind === 'end');

      if (this.waypoints.length <= 2 && isStartOrEndBeingReset) {
        waypointBeingRemoved.coords = [0, 0];
        const placeholderAddress = waypointBeingRemoved.kind === 'start' ? 'Start Point' : 'End Point';
        waypointBeingRemoved.address = placeholderAddress;
        waypointBeingRemoved.userInput = placeholderAddress;
        waypointBeingRemoved.isGeocoding = false;
      } else {
        this.waypoints.splice(index, 1);
        if (this.waypoints.length > 0 && !this.waypoints.find((wp) => wp.kind === 'start')) {
          this.waypoints[0].kind = 'start';
        }
        if (this.waypoints.length > 0 && !this.waypoints.find((wp) => wp.kind === 'end')) {
          this.waypoints[this.waypoints.length - 1].kind = 'end';
        }
      }

      if (this.shapingPoints.length > 0) {
        console.log('[RouteStore] Clearing shaping points due to hard waypoint removal/reset.');
        this.shapingPoints = [];
        useDebugStore().clearVisuals();
      }
      this.clearDraggedShapingPointBearing();
    },

    async clearShaping() {
      if (this.shapingPoints.length > 0) {
        this.shapingPoints = [];
      }
      this.clearDraggedShapingPointBearing();
      useDebugStore().clearVisuals();
    },

    async optimizeEntireRoute() {
      await this.recalc({ forceGlobalOptimize: true });
    },
  },
});

export type RouteStore = ReturnType<typeof useRouteStore>;

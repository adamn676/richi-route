// src/stores/route.store.ts
import { defineStore } from 'pinia';
import type { FeatureCollection, GeoJsonProperties } from 'geojson';
// Import BearingValue from the service where it's defined
import { getRoute, type BearingValue } from '@/services/route.service';
import { reverseGeocode, type Place, forwardGeocode } from '@/services/maptiler.service';

export type Coord = [number, number];

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

const HARD_WAYPOINT_ORS_RADIUS = 25; // meters

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
    route: null as FeatureCollection | null,
    isCalculatingGlobalRoute: false,
    // New state for temporarily holding bearing info of a dragged shaping point
    draggedShapingPointBearing: null as { id: string; bearing: BearingValue } | null,
  }),

  actions: {
    // New actions to manage bearing state for dragged SP
    setDraggedShapingPointBearing(info: { id: string; bearing: BearingValue } | null) {
      this.draggedShapingPointBearing = info;
    },
    clearDraggedShapingPointBearing() {
      this.draggedShapingPointBearing = null;
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
      const radiuses = validWaypoints.map(() => HARD_WAYPOINT_ORS_RADIUS);
      // For hard routes, bearings are generally not needed or are null
      const bearings = validWaypoints.map(() => null as BearingValue);

      console.log('[RouteStore] calculateHardRoute - Coords:', coords, 'Radiuses:', radiuses, 'Bearings:', bearings);
      try {
        const data = await getRoute(coords, radiuses, bearings);
        this.route = orsToFeatureCollection(data);
      } catch (error) {
        console.error('[RouteStore] Error in calculateHardRoute getRoute:', error);
        this.route = null;
      }
    },

    async applyShaping() {
      console.log('[RouteStore] applyShaping CALLED');
      if (!(this.route && this.route.features && this.route.features.length > 0) && this.shapingPoints.length > 0) {
        await this.calculateHardRoute();
        if (!(this.route && this.route.features && this.route.features.length > 0)) {
          console.warn('[RouteStore] applyShaping: No base route. Cannot apply shaping.');
          return;
        }
      } else if (!(this.route && this.route.features && this.route.features.length > 0)) {
        console.warn('[RouteStore] applyShaping: No base route and no SPs. Exiting.');
        return;
      }
      if (this.shapingPoints.length === 0) {
        console.log('[RouteStore] applyShaping: No shaping points.');
        return;
      }

      const validWaypoints = this.waypoints.filter((wp) => wp.coords[0] !== 0 || wp.coords[1] !== 0);
      if (validWaypoints.length < 2) {
        this.route = null;
        return;
      }
      const sortedShapingPoints = [...this.shapingPoints].sort((a, b) => a.idx - b.idx);

      const finalCoordsForORS: Coord[] = [];
      const finalRadiusesForORS: number[] = [];
      const finalBearingsForORS: BearingValue[] = []; // Initialize bearings array

      if (validWaypoints.length === 2) {
        finalCoordsForORS.push(validWaypoints[0].coords);
        finalRadiusesForORS.push(HARD_WAYPOINT_ORS_RADIUS);
        finalBearingsForORS.push(null); // Hard waypoint bearing

        sortedShapingPoints.forEach((sp) => {
          finalCoordsForORS.push(sp.coord);
          finalRadiusesForORS.push(sp.radius);
          // Apply bearing if this SP is the one being dragged
          if (this.draggedShapingPointBearing && this.draggedShapingPointBearing.id === sp.id) {
            finalBearingsForORS.push(this.draggedShapingPointBearing.bearing);
          } else {
            finalBearingsForORS.push(null); // No specific bearing for other SPs for now
          }
        });

        finalCoordsForORS.push(validWaypoints[1].coords);
        finalRadiusesForORS.push(HARD_WAYPOINT_ORS_RADIUS);
        finalBearingsForORS.push(null); // Hard waypoint bearing
      } else {
        let currentShapingPointProcessingIdx = 0;
        for (let i = 0; i < validWaypoints.length; i++) {
          finalCoordsForORS.push(validWaypoints[i].coords);
          finalRadiusesForORS.push(HARD_WAYPOINT_ORS_RADIUS);
          finalBearingsForORS.push(null); // Hard waypoint bearing

          if (i < validWaypoints.length - 1) {
            const targetIdxForShapingPoints = i + 1;
            while (
              currentShapingPointProcessingIdx < sortedShapingPoints.length &&
              sortedShapingPoints[currentShapingPointProcessingIdx].idx === targetIdxForShapingPoints
            ) {
              const sp = sortedShapingPoints[currentShapingPointProcessingIdx];
              finalCoordsForORS.push(sp.coord);
              finalRadiusesForORS.push(sp.radius);
              // Apply bearing if this SP is the one being dragged
              if (this.draggedShapingPointBearing && this.draggedShapingPointBearing.id === sp.id) {
                finalBearingsForORS.push(this.draggedShapingPointBearing.bearing);
              } else {
                finalBearingsForORS.push(null); // No specific bearing for other SPs
              }
              currentShapingPointProcessingIdx++;
            }
          }
        }
      }

      console.log('[RouteStore] applyShaping - Coords:', finalCoordsForORS, 'Radiuses:', finalRadiusesForORS, 'Bearings:', finalBearingsForORS);
      if (finalCoordsForORS.length < 2) {
        await this.calculateHardRoute();
        return;
      }
      try {
        const data = await getRoute(finalCoordsForORS, finalRadiusesForORS, finalBearingsForORS);
        this.route = orsToFeatureCollection(data);
      } catch (error) {
        console.error('[RouteStore] Error in applyShaping getRoute:', error);
        // Potentially clear draggedShapingPointBearing here on error too, or let dragend handle it
      }
    },

    async recalc(options: { forceGlobalOptimize?: boolean } = {}) {
      console.log(`[RouteStore] recalc CALLED - Options: ${JSON.stringify(options)}, ShapingPoints: ${this.shapingPoints.length}`);
      this.isCalculatingGlobalRoute = true;
      if (options?.forceGlobalOptimize) {
        this.shapingPoints = [];
        this.clearDraggedShapingPointBearing(); // Clear bearing if SPs are cleared
      }
      await this.calculateHardRoute();
      if (this.shapingPoints.length > 0 && this.route && this.route.features && this.route.features.length > 0) {
        await this.applyShaping();
      }
      // Note: draggedShapingPointBearing should be cleared by useMapMarkers on dragend
      this.isCalculatingGlobalRoute = false;
    },

    // ... (geocodeWaypoint, addWaypointByClick, addPlaceAsWaypoint, insertWaypointOnRoute unchanged)
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
        kind: place.kind || 'poi',
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
    async insertWaypointOnRoute(indexAfter: number, coord: Coord) {
      const newWp = this._addWaypointInternal(coord, 'via', 'Loading address...', '');
      this.waypoints.splice(indexAfter, 0, newWp);
      await this.geocodeWaypoint(newWp.id);
    },
    async insertShapingPoint(originalSegmentIdxPlusOne: number, coord: Coord, radius: number) {
      const newId = newShapePointId();
      this.shapingPoints.push({ id: newId, idx: originalSegmentIdxPlusOne, coord, radius });
      this.shapingPoints.sort((a, b) => a.idx - b.idx);
    },
    // updateShapingPointCoord signature doesn't need to change for bearings if using temp store state
    async updateShapingPointCoord(id: string, newCoords: Coord, radius: number) {
      const point = this.shapingPoints.find((sp) => sp.id === id);
      if (point) {
        point.coord = newCoords;
        point.radius = radius;
      }
    },
    async updateWaypointCoord(waypointId: string, newCoords: Coord) {
      const waypoint = this.waypoints.find((wp) => wp.id === waypointId);
      if (!waypoint) return;
      waypoint.coords = newCoords;
      waypoint.userInput = 'Loading address...';
      this.shapingPoints = [];
      this.clearDraggedShapingPointBearing(); // Clear bearing if SPs are cleared
      await this.geocodeWaypoint(waypointId);
    },
    async removeWaypoint(waypointId: string) {
      const index = this.waypoints.findIndex((wp) => wp.id === waypointId);
      if (index === -1) return;
      const waypoint = this.waypoints[index];
      const isStartOrEnd = waypoint.kind === 'start' || waypoint.kind === 'end';
      if (this.waypoints.length <= 2 && isStartOrEnd) {
        waypoint.coords = [0, 0];
        const placeholderAddress = waypoint.kind === 'start' ? 'Start Point' : 'End Point';
        waypoint.address = placeholderAddress;
        waypoint.userInput = placeholderAddress;
        waypoint.isGeocoding = false;
      } else {
        this.waypoints.splice(index, 1);
        if (this.waypoints.length > 0 && !this.waypoints.find((wp) => wp.kind === 'start')) {
          this.waypoints[0].kind = 'start';
        }
        if (this.waypoints.length > 0 && !this.waypoints.find((wp) => wp.kind === 'end')) {
          this.waypoints[this.waypoints.length - 1].kind = 'end';
        }
      }
      this.shapingPoints = [];
      this.clearDraggedShapingPointBearing(); // Clear bearing if SPs are cleared
    },
    async clearShaping() {
      this.shapingPoints = [];
      this.clearDraggedShapingPointBearing(); // Clear bearing if SPs are cleared
    },
    async optimizeEntireRoute() {
      await this.recalc({ forceGlobalOptimize: true });
    },
  },
});

function orsToFeatureCollection(orsData: any): FeatureCollection {
  if (!orsData) return { type: 'FeatureCollection', features: [] };
  if (orsData.error) {
    console.error('[RouteStore] ORS API Error:', orsData.error);
    return { type: 'FeatureCollection', features: [] };
  }
  if (orsData.type === 'FeatureCollection' && Array.isArray(orsData.features)) {
    orsData.features.forEach((feature: any) => {
      if (!feature.properties) feature.properties = {};
      if (orsData.extras && feature.geometry?.type === 'LineString') feature.properties.extras = orsData.extras;
      if (orsData.summary && feature.geometry?.type === 'LineString') feature.properties.summary = orsData.summary;
    });
    return orsData as FeatureCollection;
  }
  if (Array.isArray(orsData.routes) && orsData.routes.length > 0 && orsData.routes[0].geometry) {
    const route = orsData.routes[0];
    const routeProperties: GeoJsonProperties = {
      ...(route.summary && { summary: route.summary }),
      ...(orsData.extras && { extras: orsData.extras }),
      ...(route.segments && { segments: route.segments }),
    };
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: route.geometry, properties: routeProperties }],
    } as FeatureCollection;
  }
  console.warn('[RouteStore] orsToFeatureCollection: Data not recognized:', JSON.stringify(orsData).substring(0, 300) + '...');
  return { type: 'FeatureCollection', features: [] };
}

export type RouteStore = ReturnType<typeof useRouteStore>;

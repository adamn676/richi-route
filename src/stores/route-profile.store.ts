import { computed, markRaw, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { useRouteStore } from './route.store.ts';
import { isPlaced, legId, type Coord } from '../domain/route-model.ts';
import { buildGpxTrack, type GpxTrack, type GpxSegment } from '../domain/gpx-track.ts';
import { bearing, gpxGradients, gradientRuns, inspectGpxDistance, nearestTrackDistance, trackCoordinates, type GpxFocus } from '../domain/gpx-inspection.ts';

export const useRouteProfileStore = defineStore('route-profile', () => {
  const route = useRouteStore();
  const track = computed(() => {
    const points = route.points.filter(isPlaced);
    if (points.length < 2 || route.routingPending) return null;
    const segments: GpxSegment[] = [];
    for (let i = 1; i < points.length; i++) {
      const leg = route.legs[legId(points[i - 1].id, points[i].id)];
      if (!leg || leg.status !== 'routed') return null;
      segments.push({ name: '', coordinates: leg.coordinates, elevations: leg.elevations ?? leg.coordinates.map(() => null) });
    }
    return markRaw(buildGpxTrack('', '', segments, { connected: true }));
  });
  const gradients = computed(() => track.value ? gpxGradients(track.value) : []);
  const colorRuns = computed(() => track.value ? gradientRuns(track.value, gradients.value) : []);
  // The stretch the profile zooms into, and its course for the map; a changed route shows whole again.
  const range = ref<{ from: number; to: number } | null>(null);
  watch(track, () => { range.value = null; });
  const rangeCoordinates = computed(() => track.value && range.value ? trackCoordinates(track.value, gradients.value, range.value.from, range.value.to) : null);
  const selection = shallowRef<{ track: GpxTrack; focus: GpxFocus } | null>(null);
  const focus = computed(() => selection.value?.track === track.value ? selection.value?.focus ?? null : null);
  // While Street View shows a spot on the route, the profile returns to it whenever the pointer leaves.
  const rest = ref<number | null>(null);
  function focusAt(distance: number | null) {
    const value = distance ?? rest.value;
    selection.value = track.value && value !== null && Number.isFinite(value)
      ? { track: track.value, focus: inspectGpxDistance(track.value, gradients.value, value) } : null;
  }
  function restAt(distance: number | null) {
    rest.value = distance;
    focusAt(distance);
  }
  const coordinateAt = (distance: number) => track.value ? inspectGpxDistance(track.value, gradients.value, distance).coordinate : null;
  const distanceNear = (coord: Coord) => track.value ? nearestTrackDistance(track.value, coord, 30) : null;
  // Direction of travel across 30 m around a distance.
  function headingAt(distance: number) {
    const from = coordinateAt(distance - 15), to = coordinateAt(distance + 15);
    return from && to ? bearing(from, to) : null;
  }
  return { track, gradients, colorRuns, range, rangeCoordinates, focus, focusAt, restAt, coordinateAt, distanceNear, headingAt };
});

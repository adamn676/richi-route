import { computed, markRaw, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { useRouteStore } from './route.store.ts';
import { isPlaced, legId, type Coord, type RouteLeg, type Surface } from '../domain/route-model.ts';
import { buildGpxTrack, type GpxTrack, type GpxSegment } from '../domain/gpx-track.ts';
import { bearing, gpxGradients, gradientRuns, inspectGpxDistance, nearestTrackDistance, trackCoordinates, type GpxFocus } from '../domain/gpx-inspection.ts';

export const useRouteProfileStore = defineStore('route-profile', () => {
  const route = useRouteStore();
  const legs = computed(() => {
    const points = route.points.filter(isPlaced);
    if (points.length < 2 || route.routingPending) return null;
    const legs: RouteLeg[] = [];
    for (let i = 1; i < points.length; i++) {
      const leg = route.legs[legId(points[i - 1].id, points[i].id)];
      if (!leg || leg.status !== 'routed') return null;
      legs.push(leg);
    }
    return legs;
  });
  const track = computed(() => legs.value && markRaw(buildGpxTrack('', legs.value.map((leg): GpxSegment => ({ name: '',
    coordinates: leg.coordinates, elevations: leg.elevations ?? leg.coordinates.map(() => null), distanceMeters: leg.distanceMeters })),
  { connected: true })));
  const gradients = computed(() => track.value ? gpxGradients(track.value) : []);
  const colorRuns = computed(() => track.value ? gradientRuns(track.value) : []);
  // The stretch the profile zooms into, and its course for the map; a changed route shows whole again.
  const range = ref<{ from: number; to: number } | null>(null);
  watch(track, () => { range.value = null; });
  const rangeCoordinates = computed(() => track.value && range.value ? trackCoordinates(track.value, gradients.value, range.value.from, range.value.to) : null);
  // The same course in the surfaces it runs on, as the map draws the route.
  const rangeLines = computed(() => {
    const coords = rangeCoordinates.value;
    if (!coords || !legs.value || !track.value || !range.value) return null;
    const { from, to } = range.value;
    const lines: { coordinates: Coord[]; surface: Surface }[] = [];
    legs.value.forEach((leg, s) => {
      const inside = track.value!.distances[s].flatMap((distance, i) => distance > from && distance < to ? [i] : []);
      if (!inside.length) return;
      const add = (a: number, b: number, surface: Surface) => {
        const [start, end] = [Math.max(a, inside[0]), Math.min(b, inside.at(-1)!)];
        if (start < end) lines.push({ coordinates: leg.coordinates.slice(start, end + 1), surface });
      };
      let at = 0;
      for (const span of leg.surfaces) {
        add(at, span.fromIndex, 'unknown');
        add(span.fromIndex, span.toIndex, span.surface);
        at = Math.max(at, span.toIndex);
      }
      add(at, leg.coordinates.length - 1, 'unknown');
    });
    if (lines.length) {
      lines[0].coordinates.unshift(coords[0]);
      lines.at(-1)!.coordinates.push(coords.at(-1)!);
    }
    return lines;
  });
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
  return { track, gradients, colorRuns, range, rangeCoordinates, rangeLines, focus, focusAt, restAt, coordinateAt, distanceNear, headingAt };
});

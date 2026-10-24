import { computed, markRaw, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { useRouteStore } from './route.store.ts';
import { isPlaced, legId } from '../domain/route-model.ts';
import { buildGpxTrack, type GpxTrack, type GpxSegment } from '../domain/gpx-track.ts';
import { gpxGradients, inspectGpxDistance, type GpxFocus } from '../domain/gpx-inspection.ts';

export const useRouteProfileStore = defineStore('route-profile', () => {
  const route = useRouteStore();
  const track = computed(() => {
    const points = route.points.filter(isPlaced);
    if (points.length < 2 || route.pendingLegCount || route.pendingSnapCount) return null;
    const segments: GpxSegment[] = [];
    for (let i = 1; i < points.length; i++) {
      const leg = route.legs[legId(points[i - 1].id, points[i].id)];
      if (!leg || leg.status !== 'routed') return null;
      segments.push({ name: '', coordinates: leg.coordinates, elevations: leg.elevations ?? leg.coordinates.map(() => null) });
    }
    return markRaw(buildGpxTrack('', '', segments));
  });
  const gradients = computed(() => track.value ? gpxGradients(track.value) : []);
  const selection = shallowRef<{ track: GpxTrack; focus: GpxFocus } | null>(null);
  const focus = computed(() => selection.value?.track === track.value ? selection.value?.focus ?? null : null);
  function focusAt(distance: number | null) {
    selection.value = track.value && distance !== null && Number.isFinite(distance)
      ? { track: track.value, focus: inspectGpxDistance(track.value, gradients.value, distance) } : null;
  }
  return { track, focus, focusAt };
});

import { defineStore } from 'pinia';
import { computed, markRaw, ref, shallowRef, watch } from 'vue';
import { gpxMaxBytes } from '../domain/gpx-import.ts';
import type { GpxTrack } from '../domain/gpx-track.ts';
import { gpxGradients, gradientRuns, inspectGpxDistance, type GpxColorMode, type GpxFocus } from '../domain/gpx-inspection.ts';
import type { SurfaceSpan } from '../domain/route-model.ts';
import { inspectGpxSurfaces } from '../domain/gpx-surfaces.ts';
import { readGpx } from '../services/gpx-import.service.ts';
import { lookupGpxSurfaces } from '../services/gpx-surfaces.service.ts';

export const useGpxReferenceStore = defineStore('gpx-reference', () => {
  const track = shallowRef<GpxTrack | null>(null);
  const visible = ref(true);
  const loading = ref(false);
  const error = ref('');
  const fitRequest = ref(0);
  const colorMode = ref<GpxColorMode>('plain');
  const focus = shallowRef<GpxFocus | null>(null);
  const gradients = computed(() => track.value ? gpxGradients(track.value) : []);
  const colorRuns = computed(() => track.value ? gradientRuns(track.value, gradients.value) : []);
  const surfaces = shallowRef<SurfaceSpan[][] | null>(null);
  const surfaceLoading = ref(false);
  const surfaceError = ref('');
  const surfaceProgress = ref({ completed: 0, total: 0 });
  const surfaceInspection = computed(() => track.value ? inspectGpxSurfaces(track.value, surfaces.value ?? []) : null);
  let surfaceController: AbortController | undefined;
  function cancelSurfaces() {
    surfaceController?.abort();
    surfaceController = undefined;
    surfaceLoading.value = false;
  }
  async function loadSurfaces() {
    if (!track.value || surfaceLoading.value) return;
    const current = new AbortController();
    surfaceController = current;
    surfaceLoading.value = true;
    surfaceError.value = '';
    try {
      const result = await lookupGpxSurfaces(track.value, current.signal, (completed, total) => {
        if (surfaceController === current) surfaceProgress.value = { completed, total };
      });
      if (surfaceController !== current) return;
      surfaces.value = result.surfaces;
      surfaceError.value = result.error;
    } catch (cause) {
      if (surfaceController === current && !current.signal.aborted) surfaceError.value = cause instanceof Error ? cause.message : 'Beläge konnten nicht ermittelt werden.';
    } finally {
      if (surfaceController === current) { surfaceController = undefined; surfaceLoading.value = false; }
    }
  }
  function clearSurfaces() {
    cancelSurfaces(); surfaces.value = null; surfaceError.value = '';
    surfaceProgress.value = { completed: 0, total: 0 };
  }
  watch(colorMode, mode => {
    if (mode === 'surface' && !surfaces.value) void loadSurfaces();
    else if (mode !== 'surface') cancelSurfaces();
  });
  function focusAt(distance: number | null) {
    focus.value = distance === null || !Number.isFinite(distance) || !track.value
      ? null : inspectGpxDistance(track.value, gradients.value, distance);
  }
  watch(visible, value => { if (!value) { focus.value = null; cancelSurfaces(); } });
  let controller: AbortController | undefined;

  function cancel() {
    controller?.abort();
    controller = undefined;
    loading.value = false;
  }
  function remove() { cancel(); clearSurfaces(); track.value = null; focus.value = null; error.value = ''; }
  function show() { visible.value = true; fitRequest.value++; }
  async function importFile(file: File) {
    cancel();
    const current = new AbortController();
    controller = current;
    loading.value = true;
    error.value = '';
    try {
      if (file.size > gpxMaxBytes) throw new Error('Die GPX-Datei darf höchstens 32 MB groß sein.');
      const bytes = await file.arrayBuffer();
      current.signal.throwIfAborted();
      const imported = await readGpx(bytes, file.name, current.signal);
      if (controller !== current) return;
      clearSurfaces();
      track.value = markRaw(imported);
      if (!imported.elevationCount || colorMode.value === 'surface') colorMode.value = 'plain';
      focus.value = null;
      show();
    } catch (cause) {
      if (controller === current && !current.signal.aborted) {
        error.value = cause instanceof Error ? cause.message : 'Die GPX-Datei konnte nicht gelesen werden.';
      }
    } finally {
      if (controller === current) { controller = undefined; loading.value = false; }
    }
  }
  return { track, visible, loading, error, fitRequest, colorMode, focus, gradients, colorRuns, focusAt, importFile, show, remove, cancel,
    surfaces, surfaceInspection, surfaceLoading, surfaceError, surfaceProgress, loadSurfaces, cancelSurfaces };
});

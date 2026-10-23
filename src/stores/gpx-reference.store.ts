import { defineStore } from 'pinia';
import { computed, markRaw, ref, shallowRef, watch } from 'vue';
import { decodeGpx, gpxMaxBytes, parseGpx } from '../domain/gpx-import.ts';
import type { GpxTrack } from '../domain/gpx-track.ts';
import { gpxGradients, inspectGpxDistance, type GpxColorMode, type GpxFocus } from '../domain/gpx-inspection.ts';

export const useGpxReferenceStore = defineStore('gpx-reference', () => {
  const track = shallowRef<GpxTrack | null>(null);
  const visible = ref(true);
  const loading = ref(false);
  const error = ref('');
  const fitRequest = ref(0);
  const colorMode = ref<GpxColorMode>('plain');
  const focus = shallowRef<GpxFocus | null>(null);
  const gradients = computed(() => track.value ? gpxGradients(track.value) : []);
  function focusAt(distance: number | null) {
    focus.value = distance === null || !Number.isFinite(distance) || !track.value
      ? null : inspectGpxDistance(track.value, gradients.value, distance);
  }
  watch(visible, value => { if (!value) focus.value = null; });
  let controller: AbortController | undefined;

  function cancel() {
    controller?.abort();
    controller = undefined;
    loading.value = false;
  }
  function remove() { cancel(); track.value = null; focus.value = null; error.value = ''; }
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
      const imported = await parseGpx(decodeGpx(bytes), file.name, current.signal);
      if (controller !== current) return;
      track.value = markRaw(imported);
      if (!imported.elevationCount) colorMode.value = 'plain';
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
  return { track, visible, loading, error, fitRequest, colorMode, focus, gradients, focusAt, importFile, show, remove, cancel };
});

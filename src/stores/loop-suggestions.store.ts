import { markRaw, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import type { Coord } from '@/domain/route-model';
import type { LoopTarget } from '@/domain/loop-suggestions';
import { suggestLoops, type LoopSuggestion } from '@/services/loop-suggestions.service';
import { useRouteStore } from './route.store';

// The roads of the loops suggested lately from each place, newest search first, kept across visits so that each search
// brings other loops (suggestLoops): within about 1 km counts as the same place, the last four searches from it weigh
// less the older they are, and the ten places used last are kept.
type LoopHistory = Record<string, string[][][]>;
const historyKey = 'richiroute.loop-history', recency = [1, .75, .5, .3], places = 10;
const placeOf = (start: Coord) => start.map(value => value.toFixed(2)).join();
function readHistory(): LoopHistory {
  try { return JSON.parse(localStorage.getItem(historyKey) ?? '{}') as LoopHistory; } catch { return {}; }
}
function writeHistory(history: LoopHistory) {
  for (const place of Object.keys(history).slice(0, -places)) delete history[place];
  try { localStorage.setItem(historyKey, JSON.stringify(history)); } catch { /* Without storage each visit starts afresh. */ }
}

// Three loops from the start for a distance and climbing. A selected loop is shown as the route, with its profile and
// surfaces; selecting another replaces it in place, selecting it again returns to the start. Keeping one ends the
// choice; discarding returns to the start alone.
export const useLoopSuggestionsStore = defineStore('loop-suggestions', () => {
  const route = useRouteStore();
  const suggestions = shallowRef<LoopSuggestion[] | null>(null);
  const selected = ref<number | null>(null);
  const highlighted = ref<number | null>(null);
  const loading = ref(false);
  const error = ref('');
  let controller: AbortController | undefined, searchedFrom = '', undoDepth = 0;

  async function suggest(start: Coord, target: LoopTarget) {
    discard();
    searchedFrom = String(start);
    const current = controller = new AbortController();
    loading.value = true;
    try {
      const history = readHistory(), place = placeOf(start), searches = history[place] ?? [];
      const earlier = searches.flatMap((loops, i) => loops.map(cells => ({ cells, weight: recency[i] })));
      const found = await suggestLoops(start, target, current.signal, { earlier });
      if (controller !== current) return;
      suggestions.value = found.map(suggestion => ({ ...suggestion, leg: markRaw(suggestion.leg) }));
      delete history[place];
      history[place] = [found.map(suggestion => suggestion.cells), ...searches].slice(0, recency.length);
      writeHistory(history);
    } catch (cause) {
      if (controller === current) error.value = cause instanceof Error ? cause.message : 'Runden konnten nicht berechnet werden.';
    } finally {
      if (controller === current) { loading.value = false; controller = undefined; }
    }
  }
  function toggle(index: number) {
    const suggestion = suggestions.value?.[index];
    if (!suggestion) return;
    if (index === selected.value) { deselect(); return; }
    if (selected.value === null) undoDepth = route.undoStack.length;
    route.openLoop(suggestion.leg, selected.value !== null);
    selected.value = index;
  }
  // Back to the route before the first loop was shown, keeping the suggestions.
  function deselect() {
    if (selected.value !== null) while (route.undoStack.length > undoDepth && route.canUndo) route.undo();
    selected.value = null;
  }
  function clear() {
    controller?.abort();
    controller = undefined;
    loading.value = false;
    suggestions.value = null;
    selected.value = highlighted.value = null;
    error.value = '';
  }
  // Keeps the route as it is now.
  const keep = clear;
  function discard() {
    deselect();
    clear();
  }
  // A start moved by hand makes the loops stale; showing a loop sets the start itself.
  watch(() => String(route.waypoints[0]?.coord), start => {
    if (suggestions.value && start !== searchedFrom && !suggestions.value.some(loop => String(loop.leg.coordinates[0]) === start)) clear();
  });
  return { suggestions, selected, highlighted, loading, error, suggest, toggle, keep, discard, clear };
});

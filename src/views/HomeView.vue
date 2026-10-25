<template>
  <main class="editor-layout"
    :class="[`editor-layout--${sheet}`, { 'editor-layout--collapsed': collapsed, 'editor-layout--dragging': dragHeight !== null }]"
    :style="{ '--sheet-peek': peek && `${peek}px`, '--sheet-height': dragHeight === null ? undefined : `${dragHeight}px` }">
    <div ref="sheetElement" class="editor-layout__sheet">
      <!-- Phones: the sidebar is a sheet under the map; drag, tap or use the arrow keys to resize it. -->
      <button type="button" class="editor-layout__handle" :aria-label="sheetLabel" :title="sheetLabel"
        :aria-expanded="sheet !== 'peek'" aria-controls="sidebar"
        @pointerdown="startDrag" @pointermove="drag" @pointerup="endDrag" @pointercancel="endDrag"
        @click="tapped" @keydown.up.prevent="step(1)" @keydown.down.prevent="step(-1)" />
      <AppSidebar id="sidebar" class="editor-layout__sidebar" />
    </div>
    <MapView class="editor-layout__map" />
    <!-- Folds the sidebar away so the map gets the full width. -->
    <button type="button" class="editor-layout__toggle" :aria-label="toggleLabel" :title="toggleLabel"
      :aria-expanded="!collapsed" aria-controls="sidebar" @click="collapsed = !collapsed">
      <component :is="collapsed ? IconChevronRight : IconChevronLeft" :size="16" aria-hidden="true" />
    </button>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import AppSidebar from "@/components/layout/AppSidebar.vue";
import MapView from "@/components/map/MapView.vue";
import { IconChevronLeft, IconChevronRight } from '@/components/icons';
import { useRouteStore } from '@/stores/route.store';

const storageKey = 'richiroute.sidebar-collapsed';
const collapsed = ref((() => { try { return localStorage.getItem(storageKey) === '1'; } catch { return false; } })());
const toggleLabel = computed(() => collapsed.value ? 'Seitenleiste einblenden' : 'Seitenleiste ausblenden');
watch(collapsed, value => { try { localStorage.setItem(storageKey, value ? '1' : '0'); } catch { /* Storage may be disabled. */ } });

// The sheet shows its header and tabs (peek), half the screen, or all of it.
const sheets = ['peek', 'half', 'full'] as const;
const sheet = ref<typeof sheets[number]>('half');
const sheetLabel = computed(() => sheet.value === 'full' ? 'Bereich verkleinern' : 'Bereich vergrößern');
const sheetElement = ref<HTMLElement>();
const peek = ref<number>(), dragHeight = ref<number | null>(null);
const phone = window.matchMedia('(max-width: 760px)');

function heights() {
  const tabs = sheetElement.value!.querySelector('[role=tablist]')!;
  return [tabs.getBoundingClientRect().bottom - sheetElement.value!.getBoundingClientRect().top, innerHeight / 2, innerHeight];
}
// Peek fits the header and tabs, whatever the font size.
function measure() { if (phone.matches) peek.value = heights()[0]; }
function step(direction: 1 | -1) {
  sheet.value = sheets[Math.max(0, Math.min(2, sheets.indexOf(sheet.value) + direction))];
}

let start: { y: number; height: number } | null = null, moved = false;
function startDrag(event: PointerEvent) {
  start = { y: event.clientY, height: sheetElement.value!.offsetHeight };
  moved = false;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function drag(event: PointerEvent) {
  if (!start) return;
  const dy = event.clientY - start.y;
  if (Math.abs(dy) > 6) moved = true;
  if (moved) { const [peek, , full] = heights(); dragHeight.value = Math.max(peek, Math.min(full, start.height - dy)); }
}
function endDrag() {
  if (!start || dragHeight.value === null) { start = null; return; }
  // The nearest height wins; a clear pull of 48 px moves on at least one step.
  const options = heights(), current = sheets.indexOf(sheet.value);
  let nearest = options.reduce((best, height, i) => Math.abs(height - dragHeight.value!) < Math.abs(options[best] - dragHeight.value!) ? i : best, 0);
  const pulled = dragHeight.value - start.height;
  if (nearest === current && Math.abs(pulled) > 48) nearest = Math.max(0, Math.min(2, current + Math.sign(pulled)));
  sheet.value = sheets[nearest];
  dragHeight.value = null;
  start = null;
}
// A tap or Enter steps up, and from full back to peek.
function tapped() {
  if (moved) { moved = false; return; }
  sheet.value = sheet.value === 'full' ? 'peek' : sheets[sheets.indexOf(sheet.value) + 1];
}

// An opened route shows on the map, so the sheet makes way.
const { fitRequest } = storeToRefs(useRouteStore());
watch(fitRequest, () => { if (phone.matches) sheet.value = 'peek'; });
onMounted(() => { measure(); addEventListener('resize', measure); });
onBeforeUnmount(() => removeEventListener('resize', measure));
</script>

<style scoped>
/* Narrower on small laptops, wider on large screens. */
.editor-layout {
  --sidebar-width: clamp(22rem, 10.4rem + 15vw, 26rem);
  position: relative;
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  width: 100%;
  height: 100dvh;
  overflow: hidden;
}
.editor-layout--collapsed { --sidebar-width: 0px; }
.editor-layout--collapsed .editor-layout__sheet { visibility: hidden; }
/* Clip, not hidden: focus and scrollIntoView must not scroll the sheet's handle out of view. */
.editor-layout__sheet { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: clip; border-right: 1px solid var(--border); }
.editor-layout__sidebar { flex: 1; min-height: 0; }
.editor-layout__handle { display: none; }
.editor-layout__map { min-width: 0; }
/* A tab on the sidebar's edge, halfway down the map. */
.editor-layout__toggle {
  position: absolute; top: 50%; left: var(--sidebar-width); z-index: 20; display: grid; place-items: center;
  width: 1.25rem; height: 3rem; padding: 0; border: 1px solid var(--border); border-left: 0; border-radius: 0 var(--radius) var(--radius) 0;
  background: var(--surface); color: var(--text-muted); box-shadow: var(--shadow); cursor: pointer; transform: translateY(-50%);
}
.editor-layout__toggle:hover { color: var(--text); }
@media (max-width: 760px) {
  .editor-layout, .editor-layout--collapsed {
    --sheet-height: 50dvh;
    grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) var(--sheet-height);
    transition: grid-template-rows .2s ease;
  }
  .editor-layout--peek { --sheet-height: var(--sheet-peek, 8.5rem); }
  .editor-layout--full { --sheet-height: 100dvh; }
  .editor-layout--dragging { transition: none; }
  .editor-layout--collapsed .editor-layout__sheet { visibility: visible; }
  .editor-layout__map { grid-row: 1; }
  .editor-layout__sheet { border-right: 0; border-top: 1px solid var(--border); background: var(--surface); }
  .editor-layout__handle {
    display: grid; place-items: center; flex: none; width: 100%; height: 1.5rem; padding: 0; border: 0;
    background: var(--surface); cursor: grab; touch-action: none;
  }
  .editor-layout__handle::before { content: ''; width: 2.5rem; height: .25rem; border-radius: 1rem; background: var(--border-input); }
  .editor-layout--dragging .editor-layout__handle { cursor: grabbing; }
  .editor-layout__toggle { display: none; }
  /* Typing gets the whole screen, so the keyboard does not cover the field and its suggestions. */
  .editor-layout:has(.editor-layout__sidebar input.field:focus) { grid-template-rows: 0 minmax(0, 1fr); }
}
@media (max-width: 760px) and (prefers-reduced-motion: reduce) {
  .editor-layout { transition: none; }
}
</style>

<template>
  <div class="editor-layout" :class="[`editor-layout--${sheet}`, { 'editor-layout--dragging': dragHeight !== null, 'editor-layout--folded': !phone && collapsed }]">
    <!-- Desktop: a drawer that folds away. Phones: a sheet under the map; drag, tap or use the arrow keys to resize it. -->
    <v-navigation-drawer id="sidebar" tag="div" class="editor-layout__sheet" permanent
      :model-value="phone || !collapsed" :location="phone ? 'bottom' : 'start'" :width="phone ? sheetHeight : sidebarWidth">
      <template v-if="phone" #prepend>
        <button ref="handle" type="button" class="editor-layout__handle" :aria-label="sheetLabel"
          :aria-expanded="sheet !== 'peek'" aria-controls="sidebar"
          @pointerdown="startDrag" @pointermove="drag" @pointerup="endDrag" @pointercancel="endDrag"
          @click="tapped" @keydown.up.prevent="step(1)" @keydown.down.prevent="step(-1)" />
      </template>
      <AppSidebar ref="sidebar" class="editor-layout__sidebar" :folded="phone && sheet === 'peek'"
        @tab-click="sheet === 'peek' && (sheet = 'half')" />
    </v-navigation-drawer>
    <v-main class="editor-layout__main">
      <MapView />
      <!-- Folds the drawer away so the map gets the full width. -->
      <v-btn v-if="!phone" v-tooltip:end="toggleLabel" class="editor-layout__toggle" :aria-label="toggleLabel"
        :aria-expanded="!collapsed" aria-controls="sidebar" variant="flat" color="surface" rounded="e-lg"
        :width="22" :height="48" min-width="0" @click="collapsed = !collapsed">
        <component :is="collapsed ? IconChevronRight : IconChevronLeft" :size="16" aria-hidden="true" />
      </v-btn>
    </v-main>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useDisplay } from 'vuetify';
import AppSidebar from "@/components/layout/AppSidebar.vue";
import MapView from "@/components/map/MapView.vue";
import { IconChevronLeft, IconChevronRight } from '@/components/icons';
import { useRouteStore } from '@/stores/route.store';
import { useOfflineAreasStore } from '@/stores/offline-areas.store';

const { width, mobile: phone } = useDisplay();
// Narrower on small laptops, wider on large screens: 22 to 26 rem.
const sidebarWidth = computed(() => Math.round(Math.min(416, Math.max(352, 166 + .15 * width.value))));

const storageKey = 'richiroute.sidebar-collapsed';
const collapsed = ref((() => { try { return localStorage.getItem(storageKey) === '1'; } catch { return false; } })());
const toggleLabel = computed(() => collapsed.value ? 'Seitenleiste einblenden' : 'Seitenleiste ausblenden');
watch(collapsed, value => { try { localStorage.setItem(storageKey, value ? '1' : '0'); } catch { /* Storage may be disabled. */ } });

// The sheet shows its header and tabs (peek), half the screen, or all of it.
const sheets = ['peek', 'half', 'full'] as const;
const sheet = ref<typeof sheets[number]>('half');
const sheetLabel = computed(() => sheet.value === 'full' ? 'Bereich verkleinern' : 'Bereich vergrößern');
const handle = ref<HTMLElement>(), sidebar = ref<{ $el: HTMLElement }>();
const peek = ref(136), dragHeight = ref<number | null>(null);
const sheetHeight = computed(() => dragHeight.value ?? { peek: peek.value, half: '50%', full: '100%' }[sheet.value]);

// The sheet starts at its handle and reaches the bottom of the screen.
const sheetTop = () => handle.value!.getBoundingClientRect().top;
function heights() {
  const el = sidebar.value!.$el;
  const last = el.querySelector('.sidebar__summary') ?? el.querySelector('[role=tablist]')!;
  const credits = el.querySelector<HTMLElement>('.sidebar__credits')?.offsetHeight ?? 0;
  return [last.getBoundingClientRect().bottom - sheetTop() + 8 + credits, innerHeight / 2, innerHeight];
}
// Peek fits the header, the tabs, where the route goes and the credits, whatever the font size.
function measure() { if (phone.value) peek.value = heights()[0]; }
function step(direction: 1 | -1) {
  sheet.value = sheets[Math.max(0, Math.min(2, sheets.indexOf(sheet.value) + direction))];
}

let start: { y: number; height: number } | null = null, moved = false;
function startDrag(event: PointerEvent) {
  start = { y: event.clientY, height: innerHeight - sheetTop() };
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

// A route opened or completed by address shows on the map, so the sheet makes way; a single stop shows above it.
const { fitRequest, route, shownSection, routeProblem, surfaceReporting } = storeToRefs(useRouteStore());
watch([fitRequest, shownSection], () => {
  if (!phone.value || !route.value) return;
  sheet.value = 'peek';
  nextTick(measure);
});
// Correcting a surface is done on the route on the map.
watch(surfaceReporting, on => { if (on && phone.value) sheet.value = 'peek'; });
// An error of the route is reported in the sheet, which opens for it.
watch(() => Boolean(routeProblem.value), shown => { if (shown && phone.value && sheet.value === 'peek') sheet.value = 'half'; });
// Offline areas are chosen on the map with the sheet's panel beside it: half of each.
const offline = useOfflineAreasStore();
watch(() => offline.active, on => { if (on && phone.value) sheet.value = 'half'; });
onMounted(measure);
// Folded, the sheet shows where the route goes, so its height is measured again.
watch(sheet, value => { if (value === 'peek') nextTick(measure); });
watch(width, measure, { flush: 'post' });
</script>

<style scoped>
.editor-layout__sidebar { height: 100%; }
/* The map takes its new size at once rather than every frame, so it never jumps. Closing, it takes the room at once, under
   the drawer sliding away; opening, the drawer slides in over the map with its content, and the map makes room once it
   has arrived, so no empty panel shows ahead of it. */
.editor-layout__main { height: 100dvh; background: rgb(var(--v-theme-surface)); transition: none; }
.editor-layout:not(.editor-layout--folded) .editor-layout__main { transition: padding-left 0s .2s; }
/* A narrow tab on the drawer's edge, halfway down the map, with a soft shadow as the map's own controls. */
.editor-layout__toggle {
  position: absolute; top: 50%; left: var(--v-layout-left); z-index: 20; padding: 0; color: var(--text-muted);
  box-shadow: 0 1px 2px rgb(60 64 67 / .3), 0 1px 3px 1px rgb(60 64 67 / .15);
  transform: translateY(-50%); transition: left .2s cubic-bezier(.4, 0, .2, 1);
}
/* A tall strip, so a thumb finds it. */
.editor-layout__handle {
  display: grid; place-items: center; width: 100%; height: 2.25rem; padding: 0; border: 0;
  background: var(--surface); cursor: grab; touch-action: none;
}
.editor-layout__handle::before { content: ''; width: 2.5rem; height: .25rem; border-radius: 1rem; background: var(--border-input); }
.editor-layout--dragging .editor-layout__sheet { transition: none; }
.editor-layout--dragging .editor-layout__handle { cursor: grabbing; }
/* Typing gets the whole screen, so the keyboard does not cover the field and its suggestions; the drawer's own size
   is an inline style. */
@media (max-width: 760px) {
  .editor-layout__sheet:has(.v-field--focused) { height: 100% !important; }
}
</style>

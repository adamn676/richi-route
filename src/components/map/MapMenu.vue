<template>
  <div ref="root" class="map-menu" @keydown.esc="close(true)" @focusout="leave">
    <button ref="trigger" type="button" class="btn btn--icon btn--map map-menu__trigger" :aria-label="label" :title="title ?? heading"
      :aria-expanded="open" :aria-controls="panelId" aria-haspopup="dialog" @click="toggle">
      <slot name="icon" />
    </button>
    <div v-show="open" :id="panelId" ref="panel" class="map-menu__panel popover" role="dialog" tabindex="-1" :aria-labelledby="`${panelId}-title`">
      <header class="map-menu__header">
        <h2 :id="`${panelId}-title`">{{ heading }}</h2>
        <button type="button" class="btn btn--ghost btn--icon btn--sm" aria-label="Schließen" title="Schließen" @click="close(true)">
          <IconX :size="16" aria-hidden="true" />
        </button>
      </header>
      <slot :close="close" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, useId } from 'vue';
import { IconX } from '@/components/icons';

defineProps<{ label: string; heading: string; title?: string }>();
const panelId = `map-menu-${useId()}`;
const open = ref(false);
const root = ref<HTMLElement>(), trigger = ref<HTMLButtonElement>(), panel = ref<HTMLElement>();

// Opening moves focus to the selected entry (or the first one); closing by keyboard or choice returns it to the button.
async function toggle() {
  if (open.value) return close(true);
  open.value = true;
  await nextTick();
  (panel.value?.querySelector<HTMLElement>('input[type=radio]:checked') ?? panel.value?.querySelector<HTMLElement>('input'))?.focus();
}
function close(refocus = false) {
  if (!open.value) return;
  open.value = false;
  if (refocus) trigger.value?.focus();
}
// Focus moves into the panel on opening, so leaving it (Tab, another menu, a press elsewhere) closes it.
// The panel itself takes focus on presses inside it that hit no control.
function leave(event: FocusEvent) {
  if (root.value?.contains(event.relatedTarget as Node | null)) return;
  // Removing the focused control (a retry button that succeeded) also reports focus leaving; only a real move closes.
  const target = event.target as Node;
  queueMicrotask(() => { if (target.isConnected) close(); else panel.value?.focus(); });
}
</script>

<style scoped>
.map-menu__trigger { position: relative; }
.map-menu__trigger[aria-expanded=true] { border-color: var(--accent); color: var(--accent); }
/* Opens to the left of the map's tool column. */
.map-menu__panel:focus { outline: none; }
.map-menu__panel { position: absolute; top: 0; right: calc(100% + .5rem); z-index: 5; width: min(18rem, calc(100vw - 5rem));
  max-height: min(60dvh, 28rem); overflow-y: auto; padding: .35rem .85rem .85rem; }
.map-menu__header { position: sticky; top: -.35rem; display: flex; align-items: center; justify-content: space-between; gap: .5rem;
  margin: -.35rem -.35rem .25rem 0; padding-top: .35rem; background: var(--surface); }
h2 { margin: 0; font-size: .9rem; font-weight: 650; }
/* Stays within the map, which fills the top half on phones. */
@media (max-width: 760px) { .map-menu__panel { max-height: calc(50dvh - 7rem); } }
</style>

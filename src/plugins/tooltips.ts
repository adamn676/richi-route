import { nextTick } from 'vue';
import { vuetify } from './vuetify';

// When tooltips show. With a mouse, after half a second's rest on a control, so that passing over icons shows nothing;
// for a moment after one has shown, its neighbours show at once. A tap only acts: a long press shows the label instead,
// for a second and a half, and does not act. Vuetify opens a tooltip on its control's mouseenter, which a tap also causes.
const wait = 500, warmth = 300, press = 500, shown = 1500;
const control = '[aria-describedby^="v-tooltip-"]';
const tooltip = vuetify.defaults.value!.VTooltip!;

let cooling: ReturnType<typeof setTimeout> | undefined;
function warmUp() {
  tooltip.openDelay = 0;
  clearTimeout(cooling);
  cooling = setTimeout(() => { tooltip.openDelay = wait; }, warmth);
}
document.addEventListener('pointerout', event => {
  if (event.pointerType === 'mouse' && document.querySelector('.v-tooltip.v-overlay--active')) warmUp();
});

let touchedAt = -Infinity, held: Element | undefined, hiding: ReturnType<typeof setTimeout> | undefined;
let pressing: { target: Element; x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined;
function hide() {
  clearTimeout(hiding);
  held?.dispatchEvent(new MouseEvent('mouseleave'));
  held = undefined;
}
function release() {
  clearTimeout(pressing?.timer);
  pressing = undefined;
}
// The mouse events a browser derives from a touch reach no tooltip; the long press's own events are untrusted.
window.addEventListener('mouseenter', event => {
  if (event.isTrusted && performance.now() - touchedAt < 1000 && (event.target as Element).matches?.(control)) event.stopImmediatePropagation();
}, true);
document.addEventListener('touchstart', event => {
  touchedAt = performance.now();
  hide();
  const target = (event.target as Element).closest(control);
  if (!target || event.touches.length > 1) return;
  const { clientX: x, clientY: y } = event.touches[0];
  pressing = { target, x, y, timer: setTimeout(() => {
    warmUp();
    held = target;
    // Vue passes the shorter delay on to the tooltips with its next update.
    void nextTick(() => target.dispatchEvent(new MouseEvent('mouseenter')));
  }, press) };
}, { passive: true });
document.addEventListener('touchmove', event => {
  const touch = event.touches[0];
  if (pressing && Math.hypot(touch.clientX - pressing.x, touch.clientY - pressing.y) > 10) release();
}, { passive: true });
document.addEventListener('touchend', event => {
  touchedAt = performance.now();
  if (held && held === pressing?.target) {
    event.preventDefault();
    hiding = setTimeout(hide, shown);
  }
  release();
}, { passive: false });
document.addEventListener('touchcancel', release);
document.addEventListener('contextmenu', event => { if (held) event.preventDefault(); });

import { onBeforeUnmount, ref } from 'vue';

interface Drag {
  id: string;
  from: number;
  to: number;
  startY: number;
  dy: number;
  // The rows' centres and the dragged row's height, as they were when it was picked up.
  centres: number[];
  height: number;
}

// Dragging an intermediate stop by its grip: the row follows the pointer, the others make room, and the drop moves the stop
// as one step; the list's move transition then snaps the rows into place. Escape puts it back.
export function useStopDragging(move: (id: string, to: number) => void) {
  const drag = ref<Drag | null>(null);
  // Set for the frames in which a dropped stop snaps into place: the rows' drag offsets then go at once, so that only the
  // list's move transition animates.
  const settling = ref(false);
  let release: (() => void) | undefined, frame = 0;

  function start(event: PointerEvent, id: string, ids: string[]) {
    if (event.button !== 0 || drag.value) return;
    const handle = event.currentTarget as HTMLElement, list = handle.closest('ol')!;
    const rows = ids.map(other => list.querySelector<HTMLElement>(`[data-stop="${other}"]`)!);
    const from = ids.indexOf(id);
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    if (event.pointerType === 'touch') navigator.vibrate?.(10);
    drag.value = { id, from, to: from, startY: event.clientY, dy: 0, centres: rows.map(row => row.offsetTop + row.offsetHeight / 2),
      height: rows[from].offsetHeight };

    let pointerY = event.clientY;
    const onMove = (moved: PointerEvent) => {
      pointerY = moved.clientY;
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        const current = drag.value;
        if (!current) return;
        const { centres } = current;
        current.dy = Math.min(Math.max(pointerY - current.startY, centres[0] - centres[from]), centres.at(-1)! - centres[from]);
        const centre = centres[from] + current.dy;
        current.to = centres.reduce((best, c, i) => Math.abs(c - centre) < Math.abs(centres[best] - centre) ? i : best, 0);
      });
    };
    const onEnd = (ended: PointerEvent | KeyboardEvent) => {
      const { to } = drag.value!;
      release!();
      if (ended.type !== 'pointerup' || to === from) return;
      settling.value = true;
      move(id, to);
      requestAnimationFrame(() => requestAnimationFrame(() => { settling.value = false; }));
    };
    const onKey = (key: KeyboardEvent) => { if (key.key === 'Escape') onEnd(key); };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
    window.addEventListener('keydown', onKey);
    release = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('keydown', onKey);
      release = undefined;
      cancelAnimationFrame(frame);
      frame = 0;
      drag.value = null;
    };
  }

  // Where a row is drawn while a stop is dragged: the dragged one under the pointer, those it passes one row further.
  function offset(index: number): number {
    const current = drag.value;
    if (!current) return 0;
    if (index === current.from) return current.dy;
    if (current.from < index && index <= current.to) return -current.height;
    if (current.to <= index && index < current.from) return current.height;
    return 0;
  }

  onBeforeUnmount(() => release?.());
  return { drag, settling, start, offset };
}

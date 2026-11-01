import type { Map } from 'maplibre-gl';

// Dash patterns that, shown one after another, move dashes along a line in its direction; `dash` and `gap` are in line
// widths, as MapLibre measures dashes. Each pattern starts with a dash, as MapLibre wants.
export function flowingDashes(dash: number, gap: number, steps: number): number[][] {
  const period = dash + gap;
  return Array.from({ length: steps }, (_, step) => {
    const offset = step * period / steps;
    return offset + dash <= period ? [0, offset, dash, period - offset - dash] : [offset + dash - period, period - dash, period - offset];
  });
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Shows `patterns` on a line layer one after another, one every `interval` ms, until stopped; with reduced motion the
// first stands still. The browser pauses the steps while the page is hidden.
export function animateDashes(map: Map, layer: string, patterns: number[][], interval: number): () => void {
  let frame = 0, step = 0, last = 0;
  const show = (pattern: number[]) => { if (map.getLayer(layer)) map.setPaintProperty(layer, 'line-dasharray', pattern); };
  show(patterns[0]);
  if (reducedMotion()) return () => {};
  const next = (time: number) => {
    if (time - last >= interval) {
      step = (step + 1) % patterns.length;
      last = time;
      show(patterns[step]);
    }
    frame = requestAnimationFrame(next);
  };
  frame = requestAnimationFrame(next);
  return () => cancelAnimationFrame(frame);
}


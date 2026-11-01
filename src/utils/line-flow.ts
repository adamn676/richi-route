import type { ExpressionSpecification, Map } from 'maplibre-gl';

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

// A light running along a line in its direction, for 'line-gradient' (the source needs lineMetrics): `phase` from 0 to 1
// moves it once along, its fading tail leaving the end last. White over the line shows as a brighter shade of its colour.
const white = (opacity: number) => `rgba(255, 255, 255, ${opacity})`;
export function runningLight(phase: number, tail = .12): ExpressionSpecification {
  const head = phase * (1 + tail);
  return ['interpolate', ['linear'], ['line-progress'],
    head - tail, white(0), head - tail * .4, white(.45), head - .004, white(.9), head, white(1), head + .003, white(0)];
}

// Runs the light on a line layer from the start, once along in `seconds` and then resting `rest` seconds, until stopped;
// with reduced motion there is none. The browser pauses it while the page is hidden.
export function animateLight(map: Map, layer: string, seconds: number, rest: number): () => void {
  let frame = 0, last = 0, shown = -1, start: number | undefined;
  const show = (phase: number) => {
    if (phase === shown || !map.getLayer(layer)) return;
    shown = phase;
    map.setPaintProperty(layer, 'line-gradient', runningLight(phase));
  };
  show(1);
  if (reducedMotion()) return () => {};
  const next = (time: number) => {
    // About 30 steps a second are smooth enough and half the work.
    start ??= time;
    if (time - last >= 33) { last = time; show(Math.min(1, (time - start) / 1000 % (seconds + rest) / seconds)); }
    frame = requestAnimationFrame(next);
  };
  frame = requestAnimationFrame(next);
  return () => cancelAnimationFrame(frame);
}

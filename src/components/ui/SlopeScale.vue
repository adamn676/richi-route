<template>
  <!-- The colours of the profile line by gradient, laid out as the figures beside it: a label over the scale. -->
  <div class="slope-scale" role="img" :aria-label="`Linienfarbe nach Steigung: ${gradientBands.map(band => band.label).join(', ')}`">
    <span class="slope-scale__title">Steigung in %</span>
    <span class="slope-scale__scale">
      <span class="slope-scale__bar"><i v-for="band in gradientBands" :key="band.color" :style="{ backgroundColor: band.color }" /></span>
      <span class="slope-scale__labels" aria-hidden="true">
        <span v-for="(band, i) in gradientBands.slice(0, -1)" :key="band.max" :style="{ left: `${(i + 1) / gradientBands.length * 100}%` }">{{ band.max }}</span>
      </span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { gradientBands } from '../../domain/gpx-inspection';
</script>

<style scoped>
/* Sized as a figure (.stats): the label and the scale line up with their labels and values. */
.slope-scale { display: grid; row-gap: 2px; width: 6rem; color: var(--text-muted); }
.slope-scale__title { font-size: .72rem; line-height: 1.2; white-space: nowrap; }
.slope-scale__scale { display: grid; align-content: center; gap: 3px; height: 1.15em; font-size: 1.25rem; }
.slope-scale__bar { display: flex; gap: 2px; height: 5px; overflow: hidden; border-radius: 3px; }
.slope-scale__bar i { flex: 1; }
.slope-scale__labels { position: relative; height: .66rem; font-size: .66rem; line-height: 1; font-variant-numeric: tabular-nums; }
.slope-scale__labels span { position: absolute; transform: translateX(-50%); }
</style>

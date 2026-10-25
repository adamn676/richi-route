<template>
  <!-- The colours of the profile line by gradient. -->
  <div class="slope-scale" role="img" :aria-label="`Linienfarbe nach Steigung: ${gradientBands.map(band => band.label).join(', ')}`">
    <span>Steigung in %</span>
    <span class="slope-scale__bar"><i v-for="band in gradientBands" :key="band.color" :style="{ backgroundColor: band.color }" /></span>
    <span class="slope-scale__labels" aria-hidden="true">
      <span v-for="(band, i) in gradientBands.slice(0, -1)" :key="band.max" :style="{ left: `${(i + 1) / gradientBands.length * 100}%` }">{{ formatGradient(band.max) }}</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { formatGradient } from '@/utils/format';
import { gradientBands } from '../../domain/gpx-inspection';
</script>

<style scoped>
.slope-scale { display: grid; grid-template-columns: auto 6rem; gap: 2px .4rem; align-items: center; color: var(--text-muted); font-size: .65rem; }
.slope-scale__bar { display: flex; gap: 1px; height: 6px; }
.slope-scale__bar i { flex: 1; }
.slope-scale__labels { position: relative; grid-column: 2; height: .7rem; font-size: .6rem; line-height: 1; }
.slope-scale__labels span { position: absolute; transform: translateX(-50%); }
</style>

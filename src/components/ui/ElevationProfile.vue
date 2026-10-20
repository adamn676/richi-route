<template>
  <div class="profile">
    <div class="profile__title">
      <strong>Höhenprofil</strong>
      <span v-if="profile">{{ Math.round(profile.minimum) }}–{{ Math.round(profile.maximum) }} m</span>
    </div>
    <svg v-if="profile" viewBox="0 0 300 90" preserveAspectRatio="none" role="img" aria-label="Höhenprofil der Route">
      <path :d="`${profile.path} L 295 85 L 5 85 Z`" fill="#dceee7" />
      <path :d="profile.path" fill="none" stroke="#086c78" stroke-width="2.5" vector-effect="non-scaling-stroke" />
    </svg>
    <p v-else>Höhendaten erscheinen nach der Routenberechnung.</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { distanceMeters, isPlaced, legId, type RouteLeg, type RoutePoint } from '@/domain/route-model';

const props = defineProps<{
  points: RoutePoint[];
  legs: Record<string, RouteLeg>;
}>();

const profile = computed(() => {
  const placed = props.points.filter(isPlaced);
  if (placed.length < 2) return null;
  const samples: { distance: number; height: number }[] = [];
  let totalDistance = 0;

  for (let index = 0; index < placed.length - 1; index++) {
    const leg = props.legs[legId(placed[index].id, placed[index + 1].id)];
    if (!leg || leg.status === 'air' || !leg.elevations || leg.elevations.length !== leg.coordinates.length) return null;
    const elevations = leg.elevations;
    leg.coordinates.forEach((coord, vertex) => {
      if (vertex > 0) totalDistance += distanceMeters(leg.coordinates[vertex - 1], coord);
      samples.push({ distance: totalDistance, height: elevations[vertex] });
    });
  }
  if (totalDistance <= 0 || !samples.length) return null;

  let minimum = Infinity;
  let maximum = -Infinity;
  for (const sample of samples) {
    minimum = Math.min(minimum, sample.height);
    maximum = Math.max(maximum, sample.height);
  }
  const range = Math.max(maximum - minimum, 1);
  const path = samples.map((sample, index) => {
    const x = 5 + sample.distance / totalDistance * 290;
    const y = 78 - (sample.height - minimum) / range * 68;
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  return { minimum, maximum, path };
});
</script>

<style scoped>
.profile { border: 1px solid #e4e8e5; border-radius: .7rem; padding: .8rem; background: #f7f9f6; }
.profile__title { display: flex; justify-content: space-between; color: #304951; font-size: .78rem; }
svg { display: block; width: 100%; height: 5rem; margin-top: .45rem; }
.profile p { margin: .75rem 0 0; color: #67777c; font-size: .77rem; }
</style>

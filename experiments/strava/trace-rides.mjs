import { createReadStream, createWriteStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { gpxSurfacePortions, matchGpxSurfaces, splitGpxPortion } from '../../src/domain/gpx-surfaces.ts';
import { buildGpxTrack } from '../../src/domain/gpx-track.ts';
import { sectionLine, sections, shareOn } from './compare.mjs';
import { slots, startEngine, strava } from './engine.mjs';

// The road sections each ride took (.cache/strava/ridden.ndjson), traced as the planner traces an opened GPX track:
// pieces of about 2 km through a point every 100 m, kept where the trace follows the ride within 12 m, split and traced
// again where it does not. Pieces that never match leave their sections out. A ride mostly away from the roads a road bike
// can take (a trainer session with drifting GPS, a ride off-road) is left out.

// The compact tracks keep no points along straight stretches; the tracer wants one every few dozen metres.
function densify(points, spacing = 50) {
  const dense = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [[lon1, lat1], [lon2, lat2]] = [points[i - 1], points[i]];
    const steps = Math.ceil(Math.hypot((lon2 - lon1) * 111_320 * Math.cos(lat1 * Math.PI / 180), (lat2 - lat1) * 110_574) / spacing);
    for (let s = 1; s <= steps; s++) dense.push([lon1 + (lon2 - lon1) * s / steps, lat1 + (lat2 - lat1) * s / steps]);
  }
  return dense;
}

const engine = startEngine();
const output = createWriteStream(path.join(strava, 'ridden.ndjson.part'));
let rides = 0, traced = 0, total = 0, offRoad = 0;
for await (const line of readline.createInterface({ input: createReadStream(path.join(strava, 'rides.ndjson')) })) {
  const ride = JSON.parse(line);
  const points = densify(ride.points);
  const track = buildGpxTrack(ride.id, [{ name: '', coordinates: points, elevations: points.map(() => null) }]);
  const queue = gpxSurfacePortions(track), matched = [], work = slots(48);
  const length = portion => track.distances[portion.segment][portion.to] - track.distances[portion.segment][portion.from];
  total += queue.reduce((sum, portion) => sum + length(portion), 0);
  while (queue.length) {
    const portion = queue.shift();
    await work.run(async () => {
      const answer = await engine.route(portion.points);
      // The trace's surfaces don't matter here, only whether it follows the ride: within 12 m rather than the
      // planner's 8 m, as GPS strays further between steep slopes.
      if (!answer.error && matchGpxSurfaces(track, portion, { coordinates: answer.coordinates, surfaces: [] }, 12)) {
        matched.push({ ...portion, coordinates: answer.coordinates });
        traced += length(portion);
      } else queue.push(...splitGpxPortion(track, portion));
    });
    // Pieces still being traced may put their halves back in the queue.
    if (!queue.length) await work.all();
  }
  // Pieces that meet are read as one, so that the section across their joint counts too.
  const taken = new Set(), joined = [];
  for (const piece of matched.sort((a, b) => a.from - b.from)) {
    const last = joined.at(-1);
    if (last?.to !== piece.from) { joined.push({ to: piece.to, coordinates: piece.coordinates, vias: piece.points }); continue; }
    last.to = piece.to;
    last.coordinates = [...last.coordinates, ...piece.coordinates];
    last.vias = [...last.vias, ...piece.points];
  }
  for (const { coordinates, vias } of joined) for (const section of sections(coordinates, vias)) taken.add(section);
  if (shareOn(ride.points, [...taken].map(sectionLine)).share < .5) offRoad++;
  else output.write(`${JSON.stringify({ id: ride.id, sections: [...taken] })}\n`);
  if (++rides % 100 === 0) console.log(`${rides} rides, ${Math.round(traced / total * 100)} % of their length traced`);
}
await engine.close();
await new Promise(resolve => output.end(resolve));
await rename(path.join(strava, 'ridden.ndjson.part'), path.join(strava, 'ridden.ndjson'));
console.log(`${rides} rides: ${Math.round(traced / 1000)} of ${Math.round(total / 1000)} km traced onto the roads; ${offRoad} rides mostly off them left out.`);

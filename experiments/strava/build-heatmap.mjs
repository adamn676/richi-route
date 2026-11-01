import { createReadStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { gzipSync } from 'node:zlib';
import { zxyToTileId } from 'pmtiles';
import { inRoutingArea, routingArea } from '../../scripts/offline/geometry.mjs';
import { lineTile, writeArchive } from '../../scripts/offline/tiles.mjs';
import { strava } from './engine.mjs';
import { countRide, roadLines, tileLines } from './heat.mjs';

// The roads the rider took (.cache/strava/ridden.ndjson, from trace-rides.mjs) as vector tiles for the planner's
// "Richi Fahrten" (.cache/strava/rides.pmtiles): layer "rides", lines with the number of rides on them.
const [minZoom, maxZoom] = [6, 14];
const counts = new Map();
// Paved roads only: unpaved ones and those of unknown surface (forest paths) are not where the road bike goes.
for await (const line of readline.createInterface({ input: createReadStream(path.join(strava, 'ridden.ndjson')) })) {
  const { sections, unpaved } = JSON.parse(line), dirt = new Set(unpaved);
  countRide(counts, sections.filter(section => !dirt.has(section)));
}
const lines = roadLines(counts).filter(line => line.points.every(inRoutingArea));
counts.clear();

async function* tiles() {
  for (let z = minZoom; z <= maxZoom; z++) {
    const zoomTiles = [...tileLines(lines, z)].map(([key, groups]) => {
      const [x, y] = key.split('/').map(Number);
      return { tileId: zxyToTileId(z, x, y), groups };
    }).sort((a, b) => a.tileId - b.tileId);
    for (const { tileId, groups } of zoomTiles) yield { tileId, tile: gzipSync(lineTile('rides', 'rides', groups), { level: 9 }) };
  }
}
const file = path.join(strava, 'rides.pmtiles');
await writeArchive(`${file}.part`, tiles(), { minZoom, maxZoom, bounds: routingArea, center: [15.44, 47.07, 9],
  metadata: { name: 'Richi Fahrten', vector_layers: [{ id: 'rides', fields: { rides: 'Number' }, minzoom: minZoom, maxzoom: maxZoom }] } });
await rename(`${file}.part`, file);
const most = lines.reduce((max, line) => Math.max(max, line.rides), 0);
console.log(`${lines.length} lines, up to ${most} rides on one road → ${file}`);

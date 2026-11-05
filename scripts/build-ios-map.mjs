// Writes ios/RichiRoute/Map/, the street map the iPhone app draws with MapLibre Native, offline:
//   style.json, style-dark.json    the planner's map (scripts/map-style.mjs) with its relief, light and for Dark Mode, over
//                                  one offline area:
//                                  the app puts the file:// URLs of the area's map.pmtiles and terrain.pmtiles in place
//                                  of {map} and {terrain}, and for more areas repeats both sources and each layer using
//                                  them once per area; metadata carries the route colours (src/config/mapStyle.ts)
//   fonts/<font stack>/<range>.pbf the glyphs, as asset:// URLs from the app bundle's Map folder
//   sprite*.json/png               the map's icons, light and dark
// Run after changing the map style (npm run maps:setup installs the fonts and icons).
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hillshadePaint, loopColors, ridesStyle, routeStyle } from '../src/config/mapStyle.ts';
import { mapAttribution, mapLayers, terrainAttribution } from './map-style.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, 'ios/RichiRoute/Map');
const assets = path.join(root, '.cache/maps/assets');
// Latin with the neighbouring countries' letters (č ő ž …) and typographic punctuation (– „ “ ’), as the areas' labels use.
const ranges = ['0-255', '256-511', '8192-8447'];

// At night the relief stays in the background: slopes a little darker than the land, ridges a little lighter.
const darkRelief = { ...hillshadePaint, 'hillshade-shadow-color': '#111413', 'hillshade-highlight-color': '#3a413e',
  'hillshade-accent-color': '#181c1b' };

function style(night) {
  // Devanagari labels (none in the areas) take the regular font, so one font stack less.
  const layers = JSON.parse(JSON.stringify(mapLayers('map', night)).replaceAll('Noto Sans Devanagari Regular v1', 'Noto Sans Regular'));
  // The relief as the planner draws it, beneath the roads.
  const roads = layers.findIndex(layer => layer.id.startsWith('roads_tunnels_'));
  if (roads < 0) throw new Error('No roads_tunnels_* layer to put the relief beneath: has @protomaps/basemaps renamed it?');
  layers.splice(roads, 0, { id: 'hillshade', type: 'hillshade', source: 'terrain', paint: night ? darkRelief : hillshadePaint });
  return {
    version: 8, name: 'RichiRoute',
    metadata: { 'richiroute:route': routeStyle, 'richiroute:rides': ridesStyle, 'richiroute:loops': loopColors },
    glyphs: 'asset://Map/fonts/{fontstack}/{range}.pbf',
    sprite: night ? 'asset://Map/sprite-dark' : 'asset://Map/sprite',
    sources: {
      map: { type: 'vector', url: 'pmtiles://{map}', attribution: mapAttribution },
      terrain: { type: 'raster-dem', url: 'pmtiles://{terrain}', encoding: 'terrarium', tileSize: 512, attribution: terrainAttribution },
    },
    layers,
  };
}

await rm(path.join(target, 'fonts'), { recursive: true, force: true });
await mkdir(target, { recursive: true });
const styles = [style(false), style(true)];
await writeFile(path.join(target, 'style.json'), JSON.stringify(styles[0]));
await writeFile(path.join(target, 'style-dark.json'), JSON.stringify(styles[1]));
const json = JSON.stringify(styles.map(s => s.layers));
const stacks = (await readdir(path.join(assets, 'fonts'))).filter(name => json.includes(JSON.stringify(name)));
for (const stack of stacks) {
  const directory = path.join(target, 'fonts', stack);
  await mkdir(directory, { recursive: true });
  // MapLibre Native leaves a tile undrawn while a glyph range it asked for fails to load, so every other range is an
  // empty file: characters outside the ranges are left out of their labels.
  for (let start = 0; start < 65536; start += 256) {
    const range = `${start}-${start + 255}`, file = path.join(directory, `${range}.pbf`);
    await (ranges.includes(range) ? copyFile(path.join(assets, 'fonts', stack, `${range}.pbf`), file) : writeFile(file, ''));
  }
}
for (const [flavor, sprite] of [['light', 'sprite'], ['dark', 'sprite-dark']]) {
  for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) {
    await copyFile(path.join(assets, 'sprites/v4', flavor + suffix), path.join(target, sprite + suffix));
  }
}
console.log(`ios/RichiRoute/Map: ${styles[0].layers.length} layers, fonts ${stacks.join(', ')}`);

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';

const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5176';
const preview = process.env.IMAGERY_PREVIEW === '1';
const imageRequests = Number(process.env.MAP_IMAGE_REQUESTS ?? 32);
const overviewFirst = process.env.IMAGERY_OVERVIEW_FIRST !== '0';
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await page.route('**/src/composables/useEditorMap.ts*', async route => {
    const response = await route.fetch();
    let body = (await response.text()).replace(/"basemap-imagery-overview": imageryOverviewSource,?/, '');
    body = body.replace(/setMaxParallelImageRequests\([^;]+\)/, `setMaxParallelImageRequests(${imageRequests})`);
    body = overviewFirst ? body.replace('sources: {', 'sources: { "basemap-imagery-overview": imageryOverviewSource,')
      : body.replace(/(sources: \{[\s\S]*?)(\n\s*\},)/, '$1\n "basemap-imagery-overview": imageryOverviewSource,$2');
    await route.fulfill({ response, body });
  });
  await page.addInitScript(() => {
    localStorage.setItem('richiroute.review-basemap', 'street');
    localStorage.setItem('richiroute.cycling-overlays', '[]');
  });
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('.gpx-reference-layer')?.__vueParentComponent.props.map.getLayer('roads'));
  const results = [];
  for (const [place, center] of [['Graz', [15.398, 47.095]], ['Styria', [15.60, 47.13]]]) {
    await page.getByLabel('Kartenansicht', { exact: true }).selectOption('street');
    await page.evaluate(({ center, preview }) => {
      const map = document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map;
      if (preview && !map.getSource('basemap-aerial-preview')) {
        map.addSource('basemap-aerial-preview', { type: 'raster', url: '/maps/imagery-fast.json', tileSize: 256 });
        map.addLayer({ id: 'aerial-preview', type: 'raster', source: 'basemap-aerial-preview', minzoom: 9,
          paint: { 'raster-fade-duration': 0 }, layout: { visibility: 'none' } }, 'aerial');
      }
      if (preview) map.setLayoutProperty('aerial-preview', 'visibility', 'none');
      map.jumpTo({ center, zoom: 17 });
      window.previewTiming = { started: performance.now(), firstTile: {}, complete: {} };
      const onData = event => {
        const timing = window.previewTiming;
        if (event.tile && event.tile.state === 'loaded') timing.firstTile[event.sourceId] ??= Math.round(performance.now() - timing.started);
        for (const id of Object.keys(timing.firstTile)) {
          if (map.isSourceLoaded(id)) timing.complete[id] ??= Math.round(performance.now() - timing.started);
        }
      };
      if (window.previewListener) { map.off('sourcedata', window.previewListener); map.off('render', window.previewListener); }
      window.previewListener = onData;
      map.on('sourcedata', onData); map.on('render', onData);
      if (preview) map.setLayoutProperty('aerial-preview', 'visibility', 'visible');
    }, { center, preview });
    await page.getByLabel('Kartenansicht', { exact: true }).selectOption('aerial');
    await page.waitForFunction(() => document.querySelector('.gpx-reference-layer').__vueParentComponent.props.map.loaded() && window.previewTiming.complete['basemap-aerial'], null, { timeout: 60000 });
    const result = await page.evaluate(() => ({ ...window.previewTiming, total: Math.round(performance.now() - window.previewTiming.started) }));
    delete result.started;
    assert.ok(result.complete['basemap-aerial'] > 0);
    results.push({ place, preview, imageRequests, overviewFirst, ...result }); console.log(results.at(-1));
  }
  await mkdir('.cache/map-speed-dive', { recursive: true });
  await writeFile(`.cache/map-speed-dive/preview-${preview}-${imageRequests}.json`, JSON.stringify(results, null, 2));
} finally { await browser.close(); }

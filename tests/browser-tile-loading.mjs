import { chromium } from '../.cache/browser-tools/node_modules/playwright-core/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chooseBasemap } from './browser-ui.mjs';
const origin = process.env.ROUTE_TEST_ORIGIN ?? 'http://127.0.0.1:5173';
const label = process.env.TILE_BENCH_LABEL ?? 'results';
const aerialMode = process.env.TILE_BENCH_MODE ?? 'aerial';
await mkdir('.cache/tile-loading', { recursive: true });
const browser = await chromium.launch({headless:true,args:['--enable-gpu']});
try {
 const page = await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:2});
 if (process.env.MAP_IMAGE_REQUESTS) await page.route('**/src/composables/useEditorMap.ts*', async route => {
  const response = await route.fetch();
  const body = (await response.text()).replace(/setMaxParallelImageRequests\([^;]+\)/, `setMaxParallelImageRequests(${Number(process.env.MAP_IMAGE_REQUESTS)})`);
  await route.fulfill({response,body});
 });
 await page.addInitScript(() => {localStorage.setItem('richiroute.review-basemap','street');localStorage.setItem('richiroute.cycling-overlays','[]');});
 await page.goto(origin);
 await page.waitForFunction(()=>document.querySelector('.route-layer')?.__vueParentComponent.props.map.getSource('basemap-vector-europe'));
 const results=[];
 let responses=[];
 page.on('response',r=>{if(/\/maps\/imagery(?:-fast)?\//.test(r.url()) && r.status()===200)responses.push({url:r.url(),...r.headers()});});
 for(const [name,mode,center,zoom] of [
  ['street-new-area','street',[15.401,47.09],17],
  ['graz-cold',aerialMode,[15.401,47.09],17],
  ['graz-pan',aerialMode,[15.409,47.09],17],
  ['styria-cold',aerialMode,[15.60,47.13],17],
  ['virgen-cold',aerialMode,[12.458,47.001],18],
  ['graz-return',aerialMode,[15.401,47.09],17],
 ]) {
  responses=[];
  const start=performance.now();
  await chooseBasemap(page, mode);
  await page.evaluate(({center,zoom})=>{window.tileIdle=false;const map=document.querySelector('.route-layer').__vueParentComponent.props.map;
   map.once('idle',()=>window.tileIdle=true);map.jumpTo({center,zoom});},{center,zoom});
  await page.waitForFunction(()=>window.tileIdle && document.querySelector('.route-layer').__vueParentComponent.props.map.areTilesLoaded(),{},{timeout:120000});
  const result={name,ms:Math.round(performance.now()-start),tiles:responses.length,misses:responses.filter(r=>r['x-imagery-cache']==='miss').length,degraded:responses.filter(r=>r['x-imagery-degraded']==='1').length};
  results.push(result);console.log(result);
 }
 await writeFile(`.cache/tile-loading/${label}.json`,JSON.stringify(results,null,2));
} finally {await browser.close();}

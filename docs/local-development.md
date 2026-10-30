# Local development

Run commands from the repository root (`app/` in the prepared Ubuntu workspace).
Use Node.js 26.12.1 and npm 12.2.1. The native Linux setup is described below;
the historical Docker workflow retains earlier engine images and data.
Native installation needs a POSIX shell, `tar`, `bzip2` and `patch`; historical archive
setup also uses `unzip`. In PowerShell, use `npm.cmd` if execution policy blocks
`npm`. The current native launcher supports Linux x64.

## Native Linux setup

Place the existing verified benchmark bundle beside the checkout:

```text
workspace/
  app/                         # repository checkout; another name is fine
  richiroute-ubuntu-benchmark/  # separate verified routing bundle
```

The bundle must include `manifest.json`, `benchmark.mjs`, `brouter.jar`,
`profiles/` and `data/`. The original transferred bundle also contains a Node
runtime that can bootstrap installation. Its map files and patched engine are
checked by content hash. Fresh downloads or a newly built JAR are not
interchangeable with this reviewed baseline.

The bundle's map data covers 5–20° E and 45–50° N: `E10_N45.rd5` and
`E15_N45.rd5` from the original snapshot, and `E5_N45.rd5` (BRouter segments of
28 October 2026, SHA-256 `1ae307c1…88e7a5e7`), added for Vorarlberg and for
routes whose search crosses 10° E. Routes on the original tiles stay identical
with it. To add it to another copy of the bundle, place the tile from
`https://brouter.de/brouter/segments4/E5_N45.rd5` in `data/`, record its
checksum in `manifest.json` and `SHA256SUMS`, and restart the planner. A later
download differs from this one, since BRouter rebuilds its segments weekly.

The bundle is not stored in Git, and there is currently no repository command
to download that exact snapshot. A new clone can install frontend dependencies,
run unit tests and build both frontends without it; native route calculation
and engine benchmarks require the separate bundle. Do not upload the large
maps, runtime archives or private benchmark output to the source repository.

From the checkout, install the runtimes and data:

```sh
node scripts/setup-native.mjs
export PATH="$PWD/.cache/runtime/node/bin:$PATH"
npm ci
npm run search:setup
npm run maps:setup
npm run terrain:setup
npm run dev:local
```

`native:setup` downloads checksum-verified Node, GraalVM and Rust archives into
`.cache/runtime/`. It is specific to Linux x64. Rust builds the routing engine
in `engine/`, a port of BRouter 1.7.10 with the local rules (see [its porting
notes](../engine/PORTING.md)). Its parity checks compare it with the Java rules
integration, built by `npm run bench:brouter:performance` and then `npm run routing:build`. `.nvmrc` records the Node version
for other development environments. Use an existing Node 22 or newer
to run the installer. In the prepared workspace, the equivalent bootstrap is
`../richiroute-ubuntu-benchmark/runtime/node/bin/node scripts/setup-native.mjs`.
Subsequent app commands use the new runtime.

The repository launcher, `scripts/start-local.sh`, verifies the original bundle,
builds the routing engine and the address search (`cargo build --release`, quick after the first time)
and prepares the shared local rules and their profile. It then starts the engine
with twelve routing threads (the planner's six requests at a time, with room to run a request's sections
side by side) and the rules (`richi-engine serve`, BRouter's server
protocol), bound to `127.0.0.1:17777`. The address search (`richi-search serve`) runs
at `127.0.0.1:2322`, the map service at `127.0.0.1:8088` and Vite at
`127.0.0.1:5173`. It checks readiness before opening
the frontend. Ctrl+C stops the processes it started. Logs are
`experiments/routing/.local/native-{routing,search,maps}.log`. Docker, GraphHopper
and ORS are not required for this setup. The [performance build](../experiments/routing/brouter-patch/README.md#performance-overlay)
documents the engine changes and parity checks. The current native profile is
`richi-local-v1`; its comparison preset is `local-rules-v1`.

## Managing local routing rules

Edit `config/routing-rules.json` to add, disable or change a location. Weidweg's
push-through passage, the Ries bicycle turn and the Thal preference are entries
in that file. The three supported types are `passage`, `turn` and `avoidance`.
General preferences such as road surface penalties remain in the routing profile.

```sh
npm run routing:prepare
# Stop the existing native launcher with Ctrl+C, then restart it:
npm run dev:local
```

In another terminal, run `npm run routing:check`. Preparing data and restarting
the service activates new locations without rebuilding the engine. The preparation
step generates both engine data and browser notices. It rejects conflicting
rules, invalid guards and changed reviewed map tiles before writing the result.
Review geometry and tags before updating a tile checksum. A missing match never
falls back to a nearby road.

Rule changes invalidate saved leg calculations. Existing geometry remains visible
while replacement legs are calculated. Drafts from the equivalent pre-migration
policy restore without rerouting. Requests carry the complete rule revision so
an old engine cannot silently serve a browser using new rules.

Read the [rule format, matching behavior and tests](../experiments/routing/brouter-patch/README.md#configurable-local-rules)
before adding a rule. `npm run routing:benchmark` compares the previous engine
with the current rules and synthetic sets containing 1,000 and 10,000 extra rules.
It uses separate local servers and leaves the active configuration unchanged.

## Dependency status

The compatible-version review was completed on 22 October 2026. A clean
`npm ci` succeeded. A fresh `npm audit` on 24 October reported
**zero vulnerabilities** for the npm lockfile.
GitHub reported 29 dependency alerts during the push. That separate warning
has not been confirmed resolved. Check the repository's
[dependency alerts](https://github.com/adamn676/richi-route/security/dependabot)
and run `npm audit` and `npm outdated` when changing dependencies.
The last version review, on 24 October, found only the deliberate TypeScript
major-version hold:

| Component | Installed |
| --- | --- |
| Vue / Pinia | 3.5.44 / 4.1.0 |
| MapLibre GL JS | 6.15.0 |
| Vite / Vue plugin | 8.3.5 / 6.0.10 |
| vue-tsc / TypeScript | 3.3.13 / 6.0.3 |
| Vue tsconfig / devtools API | 0.9.1 / 8.2.1 |
| Node types / GeoJSON types | 26.6.5 / 7946.0.16 |
| Node / npm | 26.12.1 / 12.2.1 |
| Local browser tools | Playwright 1.64.1 / Chromium 156 |
| Local search | RichiRoute's own (`search/`), address register and OpenStreetMap data of the setup's date |
| Local map reader / style | PMTiles 4.5.0 / Protomaps basemaps 5.7.2 |
| Map extraction tool | go-pmtiles 1.31.2 |

TypeScript 7.0.2 is newer, but Vue's type checker still requires the JavaScript
compiler API. The [upstream incompatibility](https://github.com/vuejs/language-tools/issues/6124)
is tracked in [language-tools #5381](https://github.com/vuejs/language-tools/issues/5381).
TypeScript is capped at `~6.0.3` until that integration is supported.

Node 26 is the current release, rather than LTS, on this date. Node 24.22.1 was
tested first and crashed on a large BRouter response with Undici's
[`assert(!this.paused)` bug](https://github.com/nodejs/undici/issues/5360).
Node 26's bundled Undici 8.12.2 completed all 51 route comparisons. See the
[Node release status](https://nodejs.org/en/about/previous-releases).

The MapLibre 6 migration configures an explicit Vite worker asset and named ESM
imports. It requires WebGL2; WebGL1-only devices are no longer supported.
Pinia 4's devtools peer and TypeScript 6's path configuration are also updated.
Both production builds pass; their existing large-map-library size warnings
remain. The locally pinned BRouter 1.7.10, GraphHopper 11.1 and ORS 10.1.0 are
current upstream releases. Optional Docker image digests were checked and did
not need changing. GraphHopper and ORS remain optional; the address search is built by
`search:setup`.

## Historical Docker benchmark installation

The following Docker workflow preserves the bicycle-v2 comparison engine and
its historical profiles. The current editor uses the native configurable engine
described above. Stop the native launcher before starting a historical engine
on the same port; historical `weidweg-*` presets need that historical engine.

Install the JavaScript dependencies:

```sh
npm ci
```

Start Docker, then prepare the routing engines and data:

```sh
npm run bench:setup
docker compose -f experiments/routing/compose.yml build ors
npm run bench:brouter:patch
```

Setup downloads the pinned BRouter and GraphHopper releases, a Styria OpenStreetMap
extract and two BRouter regional tiles into `experiments/routing/.local/`.
Docker images are separate downloads. Existing files are checked against recorded
hashes; a mismatch stops setup rather than replacing the data.

BRouter covers 10–20° E and 45–50° N using `E10_N45.rd5` and `E15_N45.rd5`,
including Graz–Virgen. This is not worldwide coverage; the far west of Austria
also lies outside it. GraphHopper, its local road background and ORS still use
the smaller Styria extract. The online street and aerial backgrounds have
separate coverage from the routing data.

For an existing installation that reports missing `E10_N45.rd5`, run:

```sh
npm run bench:setup
docker compose -f experiments/routing/compose.yml restart brouter
```

Then select **Erneut versuchen** in the planner. The new tile is about 199 MB;
existing files are preserved. BRouter refreshes its Linux-local copy at startup,
so downloading a tile alone does not make it available to a running container.

The historical BRouter patch build uses the compiler in the local ORS image. Building that
image does not start the ORS service. The build also creates its
`richi-weidweg-v1` profile. The patch retains the Ries bicycle-turn correction and
allows the two accepted Weidweg ramped stair flights as a push-through passage;
see its [scope and checks](../experiments/routing/brouter-patch/README.md).

Create the comparison's earlier surface-v4 profile once on a fresh installation:

```sh
node --input-type=module -e "
import { readFile, writeFile } from 'node:fs/promises';
import { candidateProfile } from './experiments/routing/profiles.mjs';
const directory = 'experiments/routing/.local/brouter/profiles2/';
const baseline = await readFile(directory + 'richi-road.brf', 'utf8');
await writeFile(directory + 'richi-surface-v4.brf', candidateProfile(baseline, 'surface-v4'), { flag: 'wx' });
"
```

This command refuses to overwrite an existing profile. An already prepared
installation can skip these setup steps. `src/config/thal-preference.json` remains
the fixed Thal preference for historical comparison presets. The active editor
uses the shared rule configuration.

The editor sends `profile:pass1coefficient=2` and `profile:pass2coefficient=1`
from `src/config/routing-search.json` to guide the initial search and refinement.
The refinement finds the cheapest route only while no way costs less than its
length, which holds for the current profile; a profile change has to keep it.
The comparison preset `local-rules-v1` uses those settings and the shared rules.
The historical preset `weidweg-search-v3` retains its earlier profile and Thal
preference. Presets `weidweg-search-v1` and `weidweg-search-v2`
retain the earlier refinement-only settings `0.5` and `0.7`. Search parameters
apply per request; a changed routing policy recalculates cached legs, while
imported GPX tracks keep their recorded geometry. See the
[refinement measurements](../experiments/routing/README.md#refinement-coefficient-1-28-october-2026).

When updating an existing installation, stop BRouter before rebuilding the patch
on Windows so its JAR is not locked. Start it again with `npm run bench:up`.

## Start and stop the historical comparison services

These commands start the historical Docker comparison environment. They do
not replace `npm run dev:local` for the current planner. The comparison UI runs
on port 5174. Keep the two BRouter versions on separate ports or stop one first.

```sh
npm run bench:up
npm run bench:dev
```

Open **http://127.0.0.1:5174/** for the comparison. The first GraphHopper start imports
the map; wait for its application connector on port 8989 before using local map
tiles or comparisons. Check progress with:

```sh
docker compose -f experiments/routing/compose.yml logs --tail 30 graphhopper
```

The configured Java heaps are up to 3 GB for GraphHopper and 1 GB for BRouter;
Docker and the operating system need additional memory.

BRouter copies the prepared `.rd5` road files into its container's Linux
filesystem at startup. This avoids repeated reads through the Windows bind
mount. The source files stay in `.local/data/`; restart BRouter after updating
them. The disposable copy currently uses about 130 MB of disk space. Route
calculations still run afresh and use the same profile and road data.

On Ubuntu, keep the repository and routing data on a Linux filesystem. The native
Ubuntu follow-up reproduced all 42 Windows benchmark feature hashes; its median
route times were 8.8-11.4% lower. CPU power settings differed, so this does not
isolate the operating system's effect. See the routing guide for measurement scope.

BRouter and GraphHopper run locally; ORS is optional:

```sh
npm run bench:ors:up
```

Wait for `http://127.0.0.1:8082/ors/v2/health` to report ready, then enable
**Include local OpenRouteService** in the comparison setup. The first ORS launch
imports its own graph. Its container has a 5 GB memory limit in addition to the
other services.

Stop a dev server with Ctrl+C. Stop the engines with `npm run bench:down`.
Downloaded assets and generated graphs remain on disk.

| Service | Local port | Used for |
| --- | --- | --- |
| Planner | 5173 | Route editing and GPX export |
| Comparison app | 5174 | Engine and route review |
| Routing engine (BRouter port) | 17777 | Planner route calculation |
| GraphHopper | 8989 | Comparison routing and local road tiles |
| openrouteservice, optional | 8082 | Third comparison engine |
| Address search | 2322 | Local address search in the routing area |
| Local maps | 8088 | European vector tiles, fonts and symbols |

## European map data

`npm run maps:setup` extracts a European PMTiles archive from the official
[Protomaps builds](https://docs.protomaps.com/basemaps/downloads), with bounds
25°W–45°E and 34°N–72°N, through zoom 14. The archive is about 25 GB; zooming
closer keeps vector lines and labels sharp but cannot add details omitted from
the source tiles. The archive does not cover the whole world. Routing still
uses the separately installed routing data, currently a regional Austrian setup.

Tiles, font glyphs, symbols and the generated German street style are served
from `.cache/maps/` by `npm run maps:start`. The planner requests them through
Vite's same-origin `/maps` proxy. No public map service is used for **Karte**,
and a failed local service never triggers an online fallback. All map choices
preserve the route and profile overlays. Karte uses a calm light palette, so the
route, cycle paths and points stand out: off-white land, soft greens, white minor
roads with light outlines, pale main roads and grey motorways, which bicycles may
not use. These are road classes, not traffic measurements or a guarantee of paved
surfaces. Country borders are dashed in the place names' dark grey and thicken
with the zoom, so they stay readable in the overview; regional borders are
lighter. Labels remain above route geometry.
Map labels fade over 100 ms. MapLibre allows eight outstanding image requests
in detailed aerial mode and 32 in the other modes. The shorter queue prevents
slow regional exports from delaying local labels on HTTP/1.1; the browser's
connection limit still applies. The local overview is requested before detail.
The imagery service keeps its bounded worker and queue limits.
Street names remain visible on Karte and Satellit with or without a route. They
render above route lines and surface highlights, while route markers stay on top.

**Geländerelief** (a checkbox in the map menu, on at first) adds soft shaded relief,
softer still in town: beneath roads and labels on Karte, over OpenTopoMap. It stays off on Satellit,
whose photos already show real shadows. Run
`npm run terrain:setup` after `maps:setup`, then restart `maps:start`.
The setup extracts Europe from [Mapterhorn](https://mapterhorn.com/data-access/)
into `.cache/maps/terrain.pmtiles`, about 2.3 GB. The local map service serves
512-pixel Terrarium tiles through zoom 10; closer views enlarge that relief.
This layer helps read hills and valleys, and does not supply route elevation
measurements. [Mapterhorn and its data sources](https://mapterhorn.com/attribution/)
are credited on the map. Setup keeps 15 GiB free and skips an existing archive.
Missing terrain produces an error with retry, while other map views still work.

**Satellit** uses national tile services, such as Austria's 30 cm product, and
adds the finer Graz and Styria photos only from tile zoom 19, where they show
more detail. Their dynamic exports are slow, so everyday views stay on the fast
national tiles. It keeps vector street names, dense-screen imagery and saved
offline areas. Uncached imagery still requires an internet connection.

For national JPEG tiles fully inside Austria or France at tile zooms 10–19,
the fast mode can deliver the original bytes without Python decoding and
re-encoding. `imagery:setup` generates the small `direct-coverage.json` index
from verified country boundaries. Border tiles, higher zooms, PNG imagery and
missing coverage use the existing renderer. Connections and response sizes
are bounded, obsolete requests are cancelled, and shared requests continue
while another viewer needs them. Existing saved areas and cache limits apply.

The archive source, bounds, tool version and asset checksums are recorded in
`scripts/maps.json`. Installation verifies the native tool and font/symbol
archive with SHA-256, and checks the resulting PMTiles structure before
activating it. This structural check is not a checksum of every tile. A partial
download is never served as a complete archive. The installer requires 40 GiB
free and preserves a 15 GiB reserve during extraction. Allow more space when
installing search at the same time. Download time depends heavily on the source. The native extractor uses
HTTP/1.1 because large HTTP/2 transfers stalled in the reviewed setup.
All datasets and native tools stay in ignored `.cache/` directories.

For an update, choose an available dated build from the official build listing
and update `scripts/maps.json`. Stop the map service, move the old archive and
marker aside, run `maps:setup`, then restart the service. Daily build URLs have
limited retention; an expired URL must be replaced with an available build.
The installer does not silently replace an active archive. Keep the old archive
until the replacement has been verified if disk space permits.
Moving an old dataset to another folder on the same filesystem does not free
space. On the reviewed machine, retaining a replacement alongside all installed
datasets may require another disk.

For an isolated review, select another archive and port:

```sh
RICHIROUTE_MAP_FILE=/absolute/path/area.pmtiles MAPS_PORT=8089 npm run maps:start
```

Start Vite with the same `MAPS_PORT`; the normal launcher uses 8088.

## Online map choices

The map menu offers two local maps (**Karte**, **Satellit**) and one online map,
**OpenTopoMap · Gelände**, with contour lines, peaks and field tracks for gravel
and mountain planning. Its raster tiles load only after selection; changing a
basemap keeps route geometry, profile inspection and cycling overlays. The
selection persists, failed tiles show a retry button, and the online map also
loads when the local map service is unavailable. Its labels are baked into the
images, so they cannot move above route lines as vector labels can.

[OpenTopoMap](https://opentopomap.org/about) is CC-BY-SA and may be embedded as
long as its volunteer server is not overloaded, for example by bulk downloads;
it asks for a clearly visible credit and gives no availability guarantee. Its
[raster service is marked deprecated](https://github.com/der-stefan/OpenTopoMap)
in favour of vector tiles, so it may change or disappear. Its credit, like
every map's, stays in view at the bottom of the sidebar. Tiles are requested directly by the browser, without bulk
downloads, offline saving or prefetching. The imagery-saving command applies
only to our registered aerial sources.

CyclOSM would add cycling detail, but its OSM France host
[serves only public, non-profit sites](https://www.openstreetmap.fr/usage/),
not a private local installation, so it is not included. OpenStreetMap
Standard and the OpenFreeMap styles were dropped: they show the same
OpenStreetMap data as Karte in other colours. A different map style does not
extend routing data or make missing road-surface data available.

`node tests/browser-online-maps.mjs` checks OpenTopoMap and Radrouten with
fixture tiles (automated tests must not pan or zoom against the volunteer
servers), route preservation, local font restoration, failure recovery, visible
provider credits, persisted selection and mobile layout. Reports are in
`.cache/online-maps/`.

## Cycling overlays

The map's tool column at the top right holds the basemap choice (layers icon),
**Rad-Infos** (bike icon), **Street View** (figure icon) and **Auf Route
zoomen** (focus icon); hover for their names. Zoom buttons sit at the bottom
right; a compass joins them once the map is turned or tilted and turns it back
north. Phones zoom with two fingers and show only the compass there. The map
shows no more than the local map data's area, Europe: zooming out stops once
Europe fills the map, and the world never repeats. Opening an example, a saved
route or a GPX track as a route, or starting or completing one by address, also
shows the whole route (or the first stop alone): nearby the map glides there,
from farther away it jumps. In Street View mode a figure follows the pointer and
snaps onto the route within 16 px, the route pauses its editing, and a click
opens Street View at the nearest panorama; the figure turns grey where Google
has none within 50 m. Escape or the button again cancels. The bottom of the
sidebar lists the credits of the maps and imagery in view, OpenStreetMap once;
like every link out of the planner, theirs open in a new tab. The sidebar, the elevation profile and the controls over the map keep
one margin from every edge, 20 px (16 px on phones); icons without a background
end there with their glyph. The sidebar is a navigation drawer 352–416 px wide,
depending on the screen; the narrow tab on its edge folds it away for a
full-width map, and the app remembers that choice. The map keeps its content in
place while the drawer moves. Below 760 px the drawer becomes a sheet under the
map: drag or tap its handle (or use the arrow keys on it) to show only its
header and tabs, half the screen, or all of it. The map and elevation profile
fill the rest. Opening a route, or completing one by address, lowers the sheet
so the route shows. Typing an address opens it fully; choosing one closes the
keyboard again. A tab tapped while only the header shows raises the sheet to
half the screen. On touch screens a finger on the route pans the map; holding it
still for a moment picks the route up to drag it.

The **Route** tab lists the stops beside their markers; the + below them
(**Zwischenstopp hinzufügen**) adds an empty stop to fill by search or on the
map. An intermediate stop changes its place among the others by dragging its
grip, or with the arrow keys on the grip. Its trash can removes it, and the
notice at the panel's foot brings it back (**Rückgängig**) until the next
change. Until the saved route has loaded, the list shows its shape instead of
the empty start. Tooltips appear after the pointer has rested half a second on a
control, and at once while it moves on to the next one; on touch screens a tap
only acts, and a long press shows the control's label instead.

While an edit is calculated, the route it replaced stays on the map, faded, and
the new sections show as grey running dots once the answer takes longer than 0.3
s; each calculated section then fades in. A section that cannot be calculated
stays a red dashed straight line. Each problem is reported once, where it is
fixed: one that moving a stop fixes, such as no way within 250 m, shows in that
stop's row, and the stop is red there and on the map (a shaping point, which has
no row, turns red on the map and its problem shows in the panel). A section's own
problem, such as one too far for a single calculation, shows in the panel with
**Abschnitt zeigen**, which frames it on the map; a stop set on its red line
splits it. Problems fixed elsewhere, such as an unreachable routing service or
missing map data, offer **Erneut versuchen** there and leave the stops as they
are. On phones the sheet opens for them.

**Rad-Infos** independently toggles cycle paths, signed cycle routes,
drinking-water sources, bicycle repair stations/shops, food stops and railway
stations over all base maps. Only cycle paths are on at first; points are labelled
only where they have a name. Cycle paths and food reuse the local Protomaps tiles.
The cycle-path layer highlights `highway=cycleway`; it does not contain every
roadside cycle lane. **Radrouten** is online: the
[Waymarked Trails](https://cycling.waymarkedtrails.org) overlay of signed routes
with their numbers, international in red, national in blue, regional in orange
and local in purple. Its volunteer server allows moderate use with a credit
(CC BY-SA); failures show in Rad-Infos with a retry button. Food coverage follows
the selected basemap extract and its zoom-dependent feature selection.

Water, bicycle services and railway stations use `.cache/cycling/points.sqlite`, queried by
viewport through the local map service. Responses are limited to 2,000 points;
the control asks users to zoom in when truncated. Disabled point overlays do
not fetch data. Points start at zoom 12; food labels start at zoom 14.
Selections persist in browser storage, and clicking a point shows its details
without modifying the route.

The water filter requires `amenity=drinking_water` without a contradictory
`drinking_water` tag, or explicit `drinking_water=yes`. Decorative fountains
and unclassified springs are excluded, as are known private, inaccessible,
disused and abandoned sources. Railway stations require `railway=station` or
`railway=halt`, excluding generic rail yards. Opening hours, seasonality and access/fee tags
are retained when mapped. These records describe OSM data, not live water
quality or operating status. Attribution remains © OpenStreetMap contributors
under the [ODbL](https://www.openstreetmap.org/copyright).

For a European extract, run this occasional setup download, then restart the
map service. Overpass is used only during setup, never while browsing the map:

```sh
npm run cycling:setup
```

`RICHIROUTE_OVERPASS_URL` can point to your own Overpass instance. Public
services may time out or reject requests; failed imports preserve the installed
database. The download is bounded to 128 MiB and setup retains 15 GiB of free
disk space. There is no automatic scheduled refresh.

The initial installation uses the downloadable Austrian Geofabrik extract,
because the public Overpass endpoints were unavailable. To reproduce that
import without Overpass:

```sh
mkdir -p .cache/cycling
curl -fL https://download.geofabrik.de/europe/austria-latest.osm.pbf -o .cache/cycling/austria.osm.pbf
python3 -m pip install --target .cache/cycling-tools --only-binary=:all: osmium==4.3.2
PYTHONPATH="$PWD/.cache/cycling-tools" python3 scripts/cycling/extract.py \
  .cache/cycling/austria.osm.pbf .cache/cycling/austria.json --coverage Österreich
npm run cycling:setup -- --file .cache/cycling/austria.json
```

The converter handles OSM nodes and ways, including unnamed fountains; it
does not resolve relation geometries. It keeps coordinates only for matching
ways rather than indexing every road node. Other regional PBF files work with
the same command and an appropriate `--coverage` label. An import replaces the
previous point database; restart `maps:start` after updating it. The actual
installed coverage and OSM timestamp appear in the map control.

`node tests/browser-cycling.mjs` checks real drinking-water coverage in Graz,
map switching, point inspection, persisted selections, local requests and
mobile controls. Screenshots and reports go to `.cache/cycling/`.

## European imagery

The **Satellit** views combine a locally stored European overview with detail
imagery fetched by the local map service. Street and place names come from the
local vector map and remain above route lines in all three map modes.
No account, API key or paid imagery service is used. On dense screens, the
viewer requests up to one additional tile zoom level, capped at the source
maximum. It draws each 256-pixel image across 128 CSS pixels on a 2× screen.
This preserves available detail; it cannot add detail beyond the source image.

| Area | Imagery | Detail and terms |
| --- | --- | --- |
| Europe | [Copernicus Sentinel-2 quarterly mirror](https://source.coop/tge-labs/sentinel-2-quarterly-cloudless-mosaics), 2026 Q2 | Native 10 m imagery; local overview is downsampled. Contains modified Copernicus Sentinel data 2026, distributed by Taylor Geospatial Engine. |
| Austria | [basemap.at orthophotos](https://basemap.at/) | 30 cm product, up to tile zoom 20. CC BY 4.0, attribution "Grundkarte: basemap.at". |
| Styria, tile zoom 16–20 | [Land Steiermark orthophotos](https://data.steiermark.at/cms/beitrag/12867727/97428847/) | 20 cm imagery, bilinear reprojection; CC BY 4.0, © Land Steiermark · GIS-Steiermark. Official district polygons clip coverage. |
| Graz, tile zoom 16–20 | [City orthophotos](https://data.graz.gv.at/graz/orthophotos-graz-2/) | The catalogue links to the live OGD service, whose current layer is Orthophoto 2022. CC BY 4.0; attribution "Datenquelle: Stadt Graz – data.graz.gv.at". City boundary clipping and national fallback. |
| Switzerland | [SWISSIMAGE](https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10) | 10 cm in plains and main valleys, 25 cm in the Alps; up to zoom 20. [swisstopo free geodata terms](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices), attribution required. |
| France | [IGN BD ORTHO](https://www.data.gouv.fr/datasets/bd-ortho-r) | 20 cm product; source tiles up to zoom 19, enlarged at zoom 20. Licence Ouverte 2.0, attribution required. |

Source resolution and flight dates vary within each country. Changing the
viewer does not make the photography newer. Sentinel detail cannot show the
same small features as aerial photos. Outside the European bounds
`-25,34,45,72`, this installation has no imagery coverage. The historical
comparison app keeps its existing Austrian basemap.at layers.

```sh
npm run imagery:setup
npm run maps:start
```

Setup needs Python 3.12 or newer with pip. It installs pinned binary packages
under `.cache/imagery-tools`, without changing system Python. It verifies the
manifest and country-outline checksums, reads only small overviews from remote
Sentinel files, and creates `.cache/imagery/overview.tif`. Completed cells survive
an interrupted import. Failed cells get two retry passes; rerun setup if the
source remains unavailable. Requests use Source Cooperative's public S3 object
URLs; the manifest checksum matches the published mirror. Allow at least 2 GiB
above the 15 GiB free-space reserve; setup makes no changes to other disks.

The source registry is `scripts/imagery.json`. Country masks clip national
photography at borders, with Sentinel underneath. These outlines come from
[geoBoundaries](https://www.geoboundaries.org/), pinned to the revision in the
registry. The Austrian boundary is from BEV under CC BY-SA 2.0, the French
boundary is CC0, and the Swiss boundary follows swisstopo's OGD terms. Regional
boundaries come from the city of Graz and Land Steiermark's INSPIRE district
service under CC BY 4.0.
Attribution and original source URLs are retained in the registry and map
credits. Adaptations of the Austrian boundary remain under CC BY-SA 2.0.
Imagery licenses remain those of each provider.

The local overview draws immediately from prebuilt tiles while detail loads.
It holds about 400–550 m per pixel; the map switches to detail tiles from
zoom 7, and live Sentinel reads start at tile zoom 10.

Zoomed-out views otherwise mix the coarse overview, aerial photos from
different flights and seasons, and slow live Sentinel tiles, which looks patchy
and blurry on long routes. An optional regional mosaic fixes this for one area:

```sh
npm run imagery:region                                  # Austria and its borders
npm run imagery:region -- --bbox 5.9,45.8,17.2,49.1     # another area: west,south,east,north
```

It builds `.cache/imagery/region.tif` once from Sentinel's 40 m images
(about 38 × 39 m per pixel; for Austria roughly four minutes and 52 MB, with the
per-cell downloads kept as 60 MB in `.cache/imagery/region-cells-40m/` for
rebuilds). Inside that area, tiles at tile zooms 8–11 come only from this local
file: one even colour, rendered without network requests, also offline. Aerial
photos take over from tile zoom 12. Building another area replaces the previous one.
Restart the map service afterwards; this also replaces cached tiles.

The map service uses eight detail render workers, one offline fallback worker
and a bounded request queue. It reads only image windows needed for the current
view, selecting the appropriate Sentinel overview and loading the three colour
bands concurrently. National and city photo requests reuse HTTPS connections.
Cached boundary classification skips full polygon rasterization away from
borders. Abandoned active requests yield their workers when the next view
needs them. A local SQLite cache holds
up to 2 GiB of tile data, plus database overhead, evicting the least recently
used tiles. Cached tiles refresh after seven days when online; changes to
swisstopo's advertised cache timestamp invalidate affected cache entries.
Source-registry changes, and changes to `rendererVersion` in
`scripts/imagery/service.mjs`, invalidate cached imagery and version browser
tile URLs; bump that version when the renderer's output changes. Other renderer
code changes preserve the cache.
When an XYZ photo tile returns 404, the renderer tries up to two parent zooms
and crops the matching area before falling back to another source. This keeps
available aerial detail in places such as Virgen, where basemap.at's zoom 20
tiles are missing. Enlarging a parent tile does not add photographic detail.
Other provider failures fall back to existing cached tiles or the local overview.
Fallback tiles are not saved as complete detail images. Refresh the view after
connectivity returns to request missing detail again.

Save a small area or a corridor around an exported GPX while the map service
is running and online:

```sh
npm run imagery:save -- --name graz-center --bbox 15.43,47.065,15.45,47.08 --maxzoom 17
npm run imagery:save -- --name weekend-ride --gpx /path/to/route.gpx --buffer-km 1 --maxzoom 16
```

The command saves zoom levels 9 through the selected maximum in
`.cache/imagery/regions/<name>.mbtiles`. It limits a selection to 4,000 tiles,
uses two download requests at a time and retries temporary failures up to
three attempts. It retains interrupted downloads as `.part` files and stops before free space falls below 15 GiB. Rerun with the same
arguments to resume. Use a smaller area, narrower corridor or lower maximum
zoom for long routes. Restart the map service after a completed download.
Saved areas are never evicted by the automatic cache and include source
attribution, download date and a source-registry fingerprint. Interrupted
downloads cannot resume against different source settings. When saved areas
overlap, the most recently created archive takes priority. To update an area,
save under a new name and restart; remove the older archive afterwards if it
is no longer needed.

For a bounded Graz installation, save a broad overview and a smaller central
area with detail up to tile zoom 20:

```sh
npm run imagery:save -- --name graz-overview --bbox 15.42,47.055,15.52,47.10 --maxzoom 17
npm run imagery:save -- --name graz-center-detail --bbox 15.432,47.065,15.445,47.076 --maxzoom 20
```

These selections contain 1,282 and 2,548 tiles. At 2× density, tile zoom 20
supports map zoom 18 without enlarging pixels; higher map zooms magnify the
same images. Outside the saved bounds or zoom levels, online imagery still
loads on demand. Other areas and GPX corridors use the same command.

The European overview works without internet. Detailed offline coverage is
limited to the areas and zoom levels actually saved or still cached. To test
without upstream imagery requests, start the map service with
`RICHIROUTE_IMAGERY_OFFLINE=1 npm run maps:start`. Adding detailed imagery for
another country or region means adding an openly licensed source and verified
boundary to `countries` or `regions` in the registry. Regions take priority in
reverse registry order from their configured `minzoom`, falling back to national
photos when unavailable. XYZ URLs and image exports using a Web Mercator
`{bbox}` are supported. After changing the registry, rerun setup, restart the
map service and check border tiles.
For a new Sentinel quarter, update the source URL, manifest URL, checksum and
`revision` in `scripts/imagery.json`, rerun setup, and restart the map service.

## Address search

Address suggestions come from RichiRoute's own search (`search/`, the `richi-search`
program) through `/geocoding/api/`; it answers as [Photon](https://github.com/komoot/photon)
does, so the planner reads its results the same way. Queries stay on this computer.
Suggestions load after three characters and a 350 ms pause, with keyboard, mouse and
touch selection. Enter reuses the first loaded result.

Its data cover the routing data's area (5–20° E, 45–50° N), where a route can be
calculated:

- every Austrian address from the official address register of the BEV (Bundesamt
  für Eich- und Vermessungswesen), with its streets, municipalities and localities;
- from OpenStreetMap, towns, mountains, passes, lakes, stations, sights, shops and
  inns, the roads (to name a point on the map) and, outside Austria, the addresses.

A place matches when every word typed is in its name or around it (its town,
postcode or what it is: "Feldbach Bahnhof" finds the station named Feldbach), with
case, ß or ss and umlauts written as ae/oe/ue alike. The last word may still be
being typed, a word may be one or two letters off, and common abbreviations count
written out (Hbf, Bhf, Str., St., Gr.). Where a name says where it lies ("Sankt
Radegund bei Graz", "Stubenberg am See"), that part counts as its surroundings. A
house number on a street gives that house; a postcode rules out places with
another. Places rank by how well and how completely the words match, how known
they are (a town before a hamlet, a place with a Wikipedia article before one
without), and their distance from the map's centre.

The planner leaves out stops, platforms, railway works, shelters, signposts,
land-registry areas, and buildings that are neither an address nor a destination
(an abbey, a church or a station stays); one name in one town (a square and its
street segments) and one address (the shops at a house) show once. Each suggestion
shows its name on the first line and where it is below (the town, for a place also
its street), with an icon for its kind: address, street, town, mountain, station,
water or other place. The × in a stop's field removes the stop's point as well as
its text (a start or destination also its shaping points) and leaves the stop
empty; undo restores it. No routing geometry is sent to the search service, and
unavailable local search never falls back to an online service.

An address with a house number starts on its own street: the planner takes the
nearest point on the road of that name from its map tiles (within 150 m), since
a building's centre can lie nearer a path behind it. Georgigasse 95 in Graz, for
example, is nearer a footpath in the paid-entry Schlosspark Eggenberg than its
street; the park's paths carry no bicycle restriction in OpenStreetMap.

A stop placed or moved on the map, and the start and end of an imported GPX
track, get the street they lie on from `/geocoding/reverse` once snapped, such as
"Hahnhofweg, 8010 Graz", or the town ("8200 Gleisdorf") where no street is near. A house number is added only when that house is within
30 m, and nothing farther than 300 m names a point; then the position stays
shown. Naming adds no undo step, and typing or moving the stop cancels it. Stops of
routes saved before naming get their streets when the route is opened; that alone
does not count as a change, so switching routes saves no recovery copy, and the
names are stored with the next save.

`npm run search:setup` downloads the address register (unpacked with the system's
`unzip`) and the OpenStreetMap extracts listed in `scripts/search-data.json` (Austria, Slovenia and the
neighbouring regions from Geofabrik, about 9 GB; each checked against Geofabrik's
MD5), builds `richi-search` with the bundled Rust and then its index of the routing
area, `.cache/services/search/routing-area.search` (about 0.46 GB: road lines are kept
to within 5 m, positions are stored as small steps, and the grids that find what lies
near a point are built when it is read). Building takes
about two minutes and up to 11 GB of memory, so setup needs a computer with 16 GB
and about 15 GiB free. Downloads are kept in `.cache/services/search/downloads/`
and reused; `npm run search:setup -- --update` fetches current data and builds the
index again. Two builds from the same data give the same index.

`richi-search build --bounds west,south,east,north …` builds an index of a smaller
area instead, a region for a phone: Styria with its borders (13.55–16.2° E,
46.6–47.85° N) takes 16 MB (about 10 MB compressed), 53 MB of memory, loads in
0.1 s and answers within a millisecond on a desktop.

`npm run search:start` serves the index on `127.0.0.1:2322` (`SEARCH_PORT` chooses
another port; Vite's `/geocoding` proxy follows it). It loads in about 3 s, uses
about 1.1 GB of memory and answers most searches within 5 ms.

Another Photon-compatible service can be selected with `VITE_GEOCODING_URL`.
Export it in the shell before running Vite or building; `.env` loading is
disabled. Absolute URLs need CORS on that service. Choosing an external URL sends
search queries there. Local search is the default.

`node tests/search-quality.mjs <name> [--compare <earlier name>]` measures the
search against 238 fixed queries with the correct answers (`tests/search-cases.json`),
from easy towns and addresses across Styria to abbreviations, typos, names found in
many places, words still being typed, postcodes and neighbouring countries, plus
names for points and loops. It reports where the correct place ranks, saves the run
under its name in `.cache/search-quality/` and fails if any query does worse than
in the run compared with; `SEARCH_URL` chooses the service. Measured with the map on
Graz, Photon (the planner's former search, with the planner's adjustments for it)
found the correct place first for 96 % of the queries and among the first three for
98 %; RichiRoute's search finds it first for all but one (99.6 %) and among the first
three for all, none worse than Photon. Cases still open carry a `note`. `--verify`
checks that each expected place exists in the data.

`cargo test --release` in `search/` checks the search on a small register of its own
(house numbers, typing, typos, abbreviations, postcodes, points on the map).

`node tests/browser-search.mjs` checks real local suggestions, local routing,
keyboard and touch interaction, cancellation and controlled failure responses.
It blocks external requests. Reports and screenshots go to `.cache/search/`.
`node tests/browser-local-services.mjs` additionally checks street tiles in nine
European cities, and real search for those in the routing area, with external HTTP
requests blocked; it requires the complete datasets. Results go to `.cache/local-services/`.

## Suggest a loop

With only a start set, **Runde vorschlagen** in the Route tab takes a distance
and a climbing target (**Distanz** 10 to 1,000 km, **Höhenmeter** up to
15,000 m: type the figure or drag its slider, which steps finer where most rides
lie) and offers three loops that
start and finish there, with the map showing all three. Each card draws its
loop's shape, all on one scale, beside its name and figures; blue, ink and sky
blue tell the loops apart also with colour-blindness and are no surface colours.
Selecting a card shows
its loop as the route, in sections of about 5 km between shaping points with its
heights and surfaces, so its distance, climbing, surfaces, elevation profile and
Street View can be inspected, and the map zooms to it; the other two stay faint.
Selecting another card replaces it in place, without a further undo step;
selecting it again returns to the start and all three loops. Pointing at a card
highlights its loop. On the map, pointing at a loop highlights its card and a click
or tap selects it; while loops are offered, map clicks set no stops. **Runde übernehmen** on the selected card keeps it and
closes the suggestions; the × beside the heading returns to the start alone. On a phone the sheet stays
up while choosing. The last target is remembered in this browser.

The loops come from BRouter's round-trip mode (`engineMode=4`) with the
planner's profile: a loop through five points on a circle, which comes out about
6.2 times the circle's radius. Where a circle point snaps onto a dead end, the loop
rides in and back out; the planner cuts every stretch that returns to a point
passed less than 1 km before, so dead ends and turning circles go while the road
home a loop starts and ends on stays. It asks in twelve directions, then twice
more per direction with the radius corrected towards the distance (36 requests,
locally about 2–4 s for 50 km, 9 s for 500 km and 33 s for 1,000 km). Direction decides most of the climbing: from Graz, loops to
the north climb far more than those to the south. Of all loops, it prefers those
within 15% of the distance, then the closest climbing, and avoids roads ridden
both ways; the three it shows head at least 60° apart. Each card is named after
the town the loop passes most (sampled at eight points, not the start's town or
another card's), otherwise by its compass direction. Climbing uses the planner's
filter for router heights, so it matches the route once taken.

`node tests/browser-loops.mjs` checks the flow with mocked routing and address
services: start required, three distinct names, overview first, each loop shown
exactly as the route with zoom, no extra undo steps, deselection back to all
loops, discard, keep, a failed routing service and the phone layout.

## Route storage and export

The planner saves one draft in browser storage for `http://127.0.0.1:5173/`,
including calculated geometry, points, surfaces and elevation. Reopening restores
completed legs without recalculating them; interrupted work resumes when routing
is available. Undo history is limited to the current session.

A second tab pauses draft saving when another tab changes it.

**Meine Routen** stores named routes in IndexedDB. The list loads only route
metadata; geometry is read when opening, duplicating or exporting a route.
**Speichern** next to the name adds an entry. After opening it, the same button
updates that entry, while the copy icon saves a separate one. Each entry opens
with its folder icon, which shows the route on the **Route** tab; its menu
duplicates, renames or deletes it. Reloading restores the draft; open
its saved entry again before updating that entry.

Opening another route, starting **Neue Route**, or opening a GPX track as a route
first saves a changed route as an **Entwurf** entry. A start alone is not kept,
nor a suggested loop that is only being looked at. If saving fails or the editor changes
during that save, the switch stops and the current route stays open. Saving or
deleting an entry checks its revision inside the same database transaction, so
an outdated tab cannot silently overwrite another tab's changes. Deleting a
saved entry leaves its currently open draft intact.

**Aktuelle Route sichern** under the list exports the current editable route, including its
points, geometry, elevation, surfaces and routing revision, as `.richiroute.json`.
**Sicherung einlesen** validates that format and adds a new entry without
replacing the current draft or existing entries. Imports are limited to 64 MB.
This imports RichiRoute backups, not GPX files. Changed routing rules still cause
recalculation when opening a saved route, keeping its old geometry visible.

Clearing browser data removes both the draft and saved routes. Both use
asynchronous IndexedDB storage, so large routes fit within the browser's quota.
A draft saved in localStorage by an earlier version moves there on first load.
Named saves and backup downloads remain usable when draft autosaving fails.
Storage is specific to the browser and site origin.

The download button beside undo and redo exports the calculated track and known elevation once all
points and legs are ready. Dashed placeholder legs cannot be exported, and small
gaps stay separate track segments. Export uses GPX 1.1 without device-specific
turn instructions. Physical cycling-computer imports have not been tested.

## Inspect the route elevation profile

The planned route and imported GPX use the same interactive chart. The route's
profile spans the width of the map below it, shows **Distanz** and
**Höhenmeter** in its header, without a title (the only place for them, which
stays in view with the sidebar or sheet folded; the distance is approximate
while sections are still straight), and can be hidden with its arrow button; the
GPX profile stays in the **GPX** tab. Move the pointer or drag a finger across
**Höhenprofil** to see distance, elevation and estimated gradient beside the
cursor, with the corresponding position marked on the map. The line and a light
tint beneath it are coloured by climb, with the bands of the GPX **Steigung**
track colours and a scale beside the figures, laid out as they are; descents
share the colour of flat ground. Each part of the line shows the steepest climb
held there over about its own width on the screen (100 to 500 m), so a long
route keeps its passes visible instead of averaging them away with the flat
ground and descents around them; the colour still ends at a summit and starts in
a valley, so a descent is never coloured as a climb. The readout's dot shows the
gradient at the cursor itself. Both axes use round steps on dotted grid lines,
close to the plot, with more distance marks on wider screens; the distance axis
ends at the route's exact length, the router's like the header's. A
click (or Enter) pins the position; the tooltip then links to Google Street View
there, until Escape, another click or leaving the chart. Dragging across the
profile with a mouse, or after a long press on phones, zooms into that stretch:
the profile shows its own detail, axes and colours, the header its length,
climbing, mean gradient and steepest climb held over 100 m, the axis its exact
ends, and the map frames its course while the rest of the route fades. A double
click, Escape or the zoom-out button shows the whole profile again; so does a
changed route. The GPX profile zooms the same way. A right-click on the map, or
a long press on phones, offers Street View for any point. Without a key these
links open Google Maps in a new tab; with a Google Maps Embed API key, Street
View appears in place of the map and closes with ✕ or Escape. Opened on the
route, it looks in the direction of travel and the elevation profile keeps
marking that spot (pointing elsewhere on the profile returns to it). Google's
frame does not report walking or turning inside Street View, so the mark stays
where Street View was opened:

1. In the Google Cloud console, enable the **Maps Embed API** and create an API
   key. Google asks for a billing account; Maps Embed API use is free and
   unlimited.
2. Also enable the **Street View Static API**. The app only uses its free
   metadata lookup, to grey out Street View where there is no imagery and to
   open at the nearest panorama; without it, Street View opens unchecked.
3. Restrict the key to these two APIs and the website
   `http://127.0.0.1:5173/*`.
4. Add `VITE_GOOGLE_MAPS_EMBED_KEY=your-key` to `app/.env.local` (ignored by
   git) and restart with `./start-local.sh`, which exports that file's settings;
   when running `npm run dev` directly, export the variable in the shell.

Focus
the chart to use arrow keys, Home/End and Escape. No separate slider is shown.
Changing the route or starting recalculation clears an old position. Missing
heights stay unknown; consecutive legs join without a break.
Hover updates only the marker; it does not reroute, change the draft or resend
route geometry. Long profiles retain a bounded number of drawing samples.

`node tests/browser-route-profile.mjs` checks the planned-route interaction,
including mouse, touch, keyboard, out-and-back legs, missing heights and stale
positions. It also checks the marker across all three map modes. Reports and
screenshots go to `.cache/profile-hover/`.

## Import a GPX track

**GPX-Datei öffnen** (or dropping a file on the **GPX** tab) reads GPX 1.0 and 1.1 tracks locally and displays them as a
separate reference layer for comparison. Importing leaves the editable route, its undo history,
saved routes and GPX export unchanged. It sends no routing requests.

**Als Route öffnen** then makes the track the editable route, with the usual
map line, profile, distance, ascent and surfaces. An unsaved current route is
saved to **Meine Routen** first, the reference line is removed, and
**Rückgängig** returns to the previous route. The route keeps the track's exact
coordinates and heights, cut into sections of about 5 km (none shorter than
2.5 km) at shaping points, so an edit re-plans only the section it touches.
Shaping points show from zoom 11, so long routes are not covered in dots. Gaps
between track segments are routed. Surfaces are then looked up in the
background, as with the GPX colour mode **Untergrund**, with progress shown on the map;
sections edited meanwhile keep their own. Saving suggests the track's name. Parsing
runs in a background worker, so large files keep the page responsive, and
**Abbrechen** stops it. The icons beside the track's name show or hide it, fit the map to it, open
another file and remove it. A successful import replaces the previous
reference; an invalid file leaves it intact.

All tracks and nonempty track segments in the file are retained separately.
Single-point segments appear as dots. Distance is calculated along each segment,
without adding connections across gaps. Missing elevation remains unknown;
ascent is shown only when all elevations are present. A rise counts once it
climbs more than 2 m above the last low, and then in full, so small wobbles are
ignored but no climb is cut short. Planned routes filter the router's heights
the same way with 5 m, since its terrain grid steps by whole metres; BRouter's
own filtered ascent runs about a tenth low. On a 98 km ride with 1,673 m by the
Garmin's barometer, the file gives 1,663 m and the same path routed 1,685 m
(BRouter: 1,490 m). The small elevation chart reduces display samples for long tracks,
while stored coordinates, elevations and the map source retain every point.
Date-line crossings shift display longitudes by whole worlds without changing
the imported coordinates.

Arrows follow the recorded point order. Each segment has **S** and **Z** markers
for its start and finish. A closed segment or single point uses **S/Z**. Move
across the elevation profile with a mouse or finger to show that position on the
map. The chart itself supports keyboard input: arrow keys move the position,
Page Up/Down move further, Home/End select the endpoints and Escape clears it.
There is no separate slider. A floating readout shows distance, available
elevation and estimated gradient. Screen readers also receive the segment
number. Crossing a segment
boundary jumps to the next segment without inventing a connecting line.

**Trackfarbe** offers a plain line, elevation bands relative to the track's
minimum and maximum, or fixed gradient bands. Each colour mode has a legend;
grey means unknown. Gradients use a roughly 50 m window within continuous
elevation data. Sparse points can extend that window; spans shorter than 10 m
have no gradient estimate. These are estimates from the file's heights, so noisy
recordings can still distort them. Colour sections use at least 50 m, increasing
for very long tracks to limit rendering work, while preserving all vertices.
Profile movement updates only the map dot, without rebuilding the track.

The **Untergrund** colour mode starts optional surface lookup using the existing local
BRouter service. Nothing is requested during import. Lookup traces four
portions at a time and leaves two routing slots free; queued route edits take
priority. A 98 km recorded ride takes about 4 s. Switching away from this colour mode,
hiding the track, cancelling, removing or replacing it stops outstanding work.
Completed results stay in memory for this track; switching back reuses them.
Service errors preserve completed portions and offer a retry.

This is conservative route-following with geometry checks, not a probabilistic
GPS map matcher. Each request traces a portion of about 2 km through a recorded
point every 100 m; denser points snap onto sidewalks and side streets and send
the trace on detours. Edges longer than 200 m are left unknown. The trace must
follow the original in travel order within 8 m: both lines are walked forwards
in 5 m steps and compared by their discrete Fréchet distance, so GPS jitter and
small length differences do not matter. A portion that fails is split in half
and traced again, down to 150 m. A known material is copied only if it covers
the whole original edge; transitions within an edge remain unknown. This
preserves every original coordinate and segment break. Distances and percentages
use the original track, including unknown parts. On a 98 km recorded ride, the
previous fixed check found surfaces for 31.5 km; this one finds 76.8 km, out of
about 83 km whose roads carry surface tags.

The checks reject detours, reversed paths and missing loop legs, but closely
parallel roads and noisy recordings can still produce a wrong or missing
estimate. Surface colours are therefore labelled as estimates. Road materials
come from BRouter's OSM tags, not the online basemap. The multi-point request
format is documented in [BRouter's server handler](https://github.com/abrensch/brouter/blob/master/brouter-server/src/main/java/btools/server/request/ServerHandler.java).

The reference lasts for the current page session and is not included in saved
routes or RichiRoute backups. Reimport the original GPX after reloading, or open
it as a route to keep it. Files containing only route points or waypoints
are rejected with an explanation because they do not supply a track geometry.
Time, extension and waypoint fields are not displayed. Limits are 32 MB and
250,000 trackpoints per file. Malformed XML, invalid coordinates or elevations,
unsupported versions and document-type declarations are rejected.

`npm test` covers XML validation, versions and namespaces. Run
`node tests/browser-gpx-import.mjs` against the frontend to check worker parsing,
long tracks, partial elevation, segment boundaries, cancellation, unchanged
editor data and opening as a route (exact geometry, sections, saved previous
route, undo). It uses synthetic GPX data and does not need a routing engine;
`ROUTE_TEST_ORIGIN` selects a different frontend port. Screenshots and a report
go to `.cache/gpx-import/`.

Run `node tests/browser-gpx-inspection.mjs` to check direction markers, colour
modes, mouse, keyboard and touch inspection, missing elevations, style changes
and a 50,000-point track. It also checks that moving across the profile does not
resend full track geometry, and that profile markers, colours and direction
arrows survive switching all three map modes. Screenshots and results go to
`.cache/gpx-inspection/`. These overlay checks stub local road tiles; testing
actual local map data requires the local map service.

`node tests/browser-gpx-surfaces.mjs` checks lookup, cache reuse, unknown parts,
failure/retry, cancellation and stale replies using controlled routing responses.
`node tests/browser-map-style.mjs` checks real local vector tiles at double pixel
density, map switching, mobile layout, attribution and service failures.
Its imagery checks need internet for tiles that are not cached or saved.
`node tests/browser-imagery.mjs` checks national sources, Sentinel coverage,
borders, HTTP caching and street labels with external browser requests blocked.
Reports go to `.cache/gpx-surfaces/`, `.cache/map-style/` and `.cache/imagery-review/`.

## Inspect route surfaces

After a route finishes calculating, **Untergrund** shows the share of each
surface group as a bar and lists its length and percentage; the colours match
the route on the map: green for **Befestigt** (asphalt, concrete, paving
stones), a lighter green for **Vermutlich befestigt**, amber for
**Kopfsteinpflaster/Holzbrücke**, magenta for **Unbefestigt** (gravel, dirt and
every other unpaved material) and a light grey for **Unbekannt**. Ways without
a surface tag count by their type: roads and cycleways as likely paved, tracks
of grade 2 to 5 as unpaved. Select a group to see its sections along the route,
and select it again to close them. Select a section to frame it on the map,
drawn in its colour above the route, which fades meanwhile; select it again to
remove the highlight. **Weitere Abschnitte** shows ten more entries. Lengths
follow the drawn coordinates and can differ slightly from the engine's total. Tags describe the map data, not the current condition of a
road.

Inspection does not change the route, undo history or saved draft. Edits and
undo/redo clear the highlight. Drafts saved before the road-bike groups load
with their groups translated. The [long-route review](../experiments/routing/README.md#long-route-surface-review-22-october-2026)
records the surface-penalty experiments and why the default remains unchanged.

### Report a surface

When the map data is wrong, switch on the pencil beside **Untergrund** in the
route panel (**Untergrund korrigieren**; on phones the sheet folds away) and tap
the start and the end of the stretch on the route; until the end is tapped, the
stretch follows the pointer and the banner shows its length.
A card then offers the surface groups in the route's colours (**Befestigt**,
**Unbefestigt**, **Kopfsteinpflaster/Holzbrücke**), with the current one ticked,
and **Laut Karte** where the stretch is already corrected. One tap saves the
choice and recolours the route; the next stretch can follow at once. **Esc** or
the pencil ends reporting, as does Street View, which also takes clicks on the map. The **Untergrund** list marks corrected sections
with **korrigiert**.

The planner's server saves each report to
[`config/surface-corrections.json`](../config/surface-corrections.json), one
line per stretch with its points, the surface, the date and the surfaces OSM had
there, and writes the engine's copy
(`experiments/routing/.local/local-routing-rules/surfaces.tsv`), which the
engine reads again for its next route, without a restart. A new report replaces
older ones where they overlap.

The engine routes and describes a corrected stretch as if OSM had tagged it that
way (`surface=paved`, `unpaved` or `cobblestone`, with the track grade and
smoothness made to fit), so the profile prices it like any other road of that
surface, and adds what OSM says as `osm:surface=…`. A correction covers exactly
the reported stretch, also in the middle of a road; it starts and ends at points
of the map's road geometry, a few metres apart in towns and further apart on
long straight roads. Where OSM has since changed the surface, the correction
lapses and OSM's tag counts again. Only planned routes can be reported:
imported tracks lie beside the roads, not on them. Reports are saved only by
the local planner (`npm run dev:local`).

## Checks

The [Checks workflow](../.github/workflows/checks.yml) runs on pushes to `main`
and pull requests, and can also be started manually in GitHub Actions. It uses
the Node version in `.nvmrc` and the npm version in `package.json`, performs
`npm ci`, then runs both unit-test suites and both production builds, including
TypeScript checks. It also runs the GPX import, GPX surface and saved-route
browser checks against the development server, because they do not need local
services. Native engine, live routing and the other browser checks remain local
because they need the separate routing bundle and prepared services.

Unit tests and builds do not need running engines:

```sh
npm test
npm run build
npm run bench:test
npm run bench:build
```

With prepared assets and BRouter running:

```sh
npm run bench:check-reviewed
npm run test:weidweg-local
```

This protects 14 reviewed route variants and reports the western-loop composite
as a separate target using the editor's `local-rules-v1` settings. The passage
check also verifies both directions and opt-out behaviour. Requests, responses
and reports stay in the ignored `.local/`
directory. Do not replace expected geometry just to make a failing check pass.
Fresh map downloads can differ from the data used for the saved reviews.

The native rules preparation stages the current profile and an opt-out
`richi-surface-v4` comparison profile in `.local/local-routing-rules/profiles/`.
The original minimal benchmark bundle is unchanged. Historical `weidweg-*`
comparisons require the preserved bicycle-v2 engine; use `local-rules-v1` with
the current native service.

With the planner server also running:

```sh
npm run test:editor-local
```

This exercises the same protected routes through the editor and checks that local
edits preserve distant legs. Browser scripts in `tests/` additionally require
Chrome or the downloaded Chromium and Playwright at `.cache/browser-tools/`; that
installation is not supplied by `npm ci`. Their screenshots and reports are ignored.

`node tests/browser-long-routes.mjs` builds Graz–Virgen across two map tiles
(339 km), a 252 km single leg and a 242 km loop in isolated browser contexts.
It checks drawing, all exported coordinates and elevations, saved reload,
local editing and undo without changing your draft.

`node tests/browser-surfaces.mjs` checks a fresh Graz-Virgen route, exact map
highlighting, desktop and mobile layouts, section pagination, undo/redo and
saved/legacy draft restoration. It also uses isolated browser contexts.

`node tests/browser-initial-performance.mjs --baseline 0.5` compares the current
search settings with the previous optimization on fresh 339 km and 523 km legs
and a 1,131 km loop. Omit `--baseline 0.5` to use BRouter's original zero default.
It measures calculation through first map drawing, checks exact geometry,
elevation and surfaces, and verifies that each run sends every snap and leg
request. It uses one warmup and three measured runs per setting, alternates
their order, and excludes background tile downloads. Keep other routing and
build jobs idle during this measurement. Reports are named
`experiments/routing/.local/initial-route-speed/browser-comparison-BASELINE-to-PASS1-PASS2.json`.
The first round's `browser-comparison.json` remains unchanged.

The optional `--baseline-origin` and `--optimized-origin` arguments compare two
local engines through the same browser interception path. Both must serve the
current profile and rule revision. The preserved Java 21/bicycle-v2 engine uses
the earlier profile, so it cannot directly accept the current editor's requests.
Its 22 October comparison remains in `browser-max-optimization.json`.

Use `npm run routing:benchmark` for the current/legacy engine and rule-count
comparison. It starts and stops isolated engines, translates each variant's
profile and rule parameters, and checks complete route features. Its server
timings exclude browser drawing; the browser command above measures the editor.

On Ubuntu, install the optional browser tools and a matching Chromium locally:

```sh
npm install --prefix .cache/browser-tools --no-save --package-lock=false playwright-core@1.64.1
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/browsers"
node .cache/browser-tools/node_modules/playwright-core/cli.js install chromium
node tests/browser-long-routes.mjs
node tests/browser-surfaces.mjs
node tests/browser-saved-routes.mjs
node tests/browser-gpx-import.mjs
node tests/browser-loops.mjs
node tests/browser-initial-performance.mjs --baseline 0.5
```

The browser scripts use the downloaded Chromium when `PLAYWRIGHT_BROWSERS_PATH` is
set; otherwise they use installed Chrome. Screenshots from the surface check are
in `experiments/routing/.local/surface-browser/`.

The saved-route browser check uses synthetic routes and real IndexedDB without
a running routing engine. It covers large-route fidelity, backup round-trips,
recovery on switching, conflicting tabs and transaction failures. Set
`ROUTE_TEST_ORIGIN` to test a separate frontend port. Its screenshots and downloaded
backup go to `.cache/saved-routes/`.

Further browser checks, run the same way: `browser-initial-route.mjs` (a route
appears at once, edits keep it visible, failures show dashed sections and one
error), `browser-local-rules.mjs` (rule notices, refreshing stale routes, rule
revisions), `browser-route-files.mjs` (reopening without routing, exact GPX
export, drafts across tabs, full storage) and `browser-western-example.mjs`
(the stored western loop with its shaping points, through reload and undo).

To watch the editor check in a browser window and record a replay:

```sh
PLAYWRIGHT_HEADED=1 PLAYWRIGHT_SLOW_MO=200 PLAYWRIGHT_TRACE=1 node tests/browser-editor.mjs
node .cache/browser-tools/node_modules/playwright-core/cli.js show-trace \
  experiments/routing/.local/editor-trace.zip --host 127.0.0.1 --port 9323
```

In VS Code, **Ctrl+Alt+/** opens the integrated browser. Open
`http://127.0.0.1:5173/` for the app or `http://127.0.0.1:9323/` for the recorded
test replay. These are standalone Playwright scripts; an app preview tab does
not automatically mirror their separate live browser session. Performance
measurements use headless execution without slow motion or tracing.

## Builds and deployment

`npm run build` creates the planner in `dist/`. `npm run bench:build` creates the
comparison app in `experiments/routing/dist/`.

Check the planner's actual built map worker, WebGL2 context, routing and export:

```sh
npm run preview -- --host 127.0.0.1 --port 5175
# In another terminal, with the local router running:
node tests/browser-production.mjs
```

The development servers proxy requests to local engines. Serving the built files
alone does not provide routing: a deployment needs equivalent same-origin proxies
for `/routing`, `/maps` and `/geocoding`. The built planner has no default
external street-map or address-search service. The historical comparison
additionally uses `/tiles`.
The comparison also needs its
development API or a replacement server. There is no deployment configuration in
this repository.

Engine comparisons, profile history and map-data limitations are documented in
the [routing guide](../experiments/routing/README.md).

Imagery performance checks after setup:

For cold-load comparisons, start a separate map service with
`MAPS_PORT=8089 RICHIROUTE_IMAGERY_CACHE=/tmp/richiroute-benchmark-detail.sqlite npm run maps:start`
and a preview with `MAPS_PORT=8089 npm run dev -- --port 5176`.
Use a new cache filename for each run and restart the map service between modes:

```sh
ROUTE_TEST_ORIGIN=http://127.0.0.1:5176 TILE_BENCH_LABEL=satellite node tests/browser-tile-loading.mjs
```

The script waits for map idle and loaded tiles after each move. It records
timings, cache misses and degraded responses under `.cache/tile-loading/`.
On 2026-10-23, separate GPU Chromium runs at 1440×1000 and 2× pixel density
measured the following. Both runs started with empty caches and fresh workers;
all detail requests in these four views were misses, with no degraded responses.

| Uncached aerial view | Detail | Fast |
| --- | ---: | ---: |
| First Graz view | 3.57 s | 1.30 s |
| Pan to another Graz area | 5.95 s | 0.45 s |
| Styria | 3.33 s | 0.65 s |
| Virgen | 1.82 s | 1.72 s |

These timings include network variation. The Graz/Styria improvement comes from
choosing national tiled imagery instead of finer regional exports. They come from
the former separate Detail and Fast views; **Satellit** now uses the fast path
below tile zoom 19. Virgen uses
the same provider in both modes. This is a separate browser measurement, not
a measurement of VS Code's embedded browser. The discarded larger-export
experiments were slower and are not part of the implementation.

The 2026-10-24 scheduling check used the same GPU Chromium viewport and fresh
temporary caches. In Graz's detailed view, requesting the local overview first
and limiting slow-image queueing changed these source-load times:

| Graz detailed view | Previous ordering, 32 requests | Final ordering, 8 requests |
| --- | ---: | ---: |
| Local overview ready | 4.33 s | 0.019 s |
| Local vector source ready | 3.27 s | 1.10 s |
| Detailed imagery complete | 4.52 s | 4.47 s |

These are source readiness timings, not promises about the next painted frame.
The full-resolution imagery is unchanged. The gain is an earlier usable map
and labels while the regional provider finishes. An extra national preview
layer did not help consistently and was discarded. Four and six image requests
reduced imagery throughput; fast mode retains 32. Its final cold views measured
0.53 s for Graz, 0.38 s for the Graz pan, 0.35 s for Styria and 1.95 s for Virgen,
with no degraded responses. The Virgen result does not demonstrate an
improvement over the earlier 1.72 s run; source latency and missing high-zoom
tiles remain constraints there.

`tests/browser-imagery-preview.mjs` reproduces scheduling experiments with
`MAP_IMAGE_REQUESTS`, `IMAGERY_OVERVIEW_FIRST=0` for the old source order, and
`IMAGERY_PREVIEW=1` for the rejected extra layer. Use a fresh temporary cache
and service restart for each run. `tests/browser-map-zooming.mjs` measures rapid
zoom cancellation, and `tests/browser-map-performance.mjs` compares vector
worker counts and overscaling. Artifacts go to `.cache/map-speed-dive/` and
`.cache/map-performance/`. Extra vector workers and tile splitting did not
improve the reviewed machine: local vector views settled in roughly 0.14–0.27 s
with 17 ms frame-time p95 and no recorded main-thread long tasks. VS Code's
status reported hardware-accelerated WebGL, but these timings were measured
in a separate GPU Chromium instance, not its embedded browser.

```sh
PYTHONPATH="$PWD/.cache/imagery-tools" python3 tests/imagery-render.test.py
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/browsers" node tests/browser-imagery-performance.mjs
```

Use `RICHIROUTE_IMAGERY_CACHE` on an isolated map-service instance for cold-cache
measurements without deleting the normal cache. Browser measurements go to
`.cache/imagery-performance/`; timings depend on upstream latency and cache state.

`tests/browser-imagery-local.mjs` compares requested detail levels and load times
on 1× and 2× screens. Set `IMAGERY_EXPECT_SAVED=1` and point `ROUTE_TEST_ORIGIN`
to a preview backed by a map service running with `RICHIROUTE_IMAGERY_OFFLINE=1`
to prove the central Graz views use only saved tiles. Reports and screenshots
are stored under `.cache/imagery-local/`.

`node tests/browser-map-rendering.mjs` measures complete view settling and frame
intervals during pans in all three modes at map zooms 12, 16 and 18. It requests
GPU acceleration and records the actual renderer in `.cache/map-rendering/report.json`.
Compare runs with the same renderer, viewport and cache state. Headless Chromium
can otherwise use SwiftShader, which is not representative of a GPU-accelerated
VS Code browser. These timings do not measure the surrounding VS Code webview.

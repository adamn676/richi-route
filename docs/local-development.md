# Local development

Run commands from the repository root (`app/` in the prepared Ubuntu workspace).
Use Node.js 26.12.1 and npm 12.2.1. The native Linux setup is described below;
the historical Docker workflow retains earlier engine images and data.
Native installation needs a POSIX shell, `tar` and `patch`; historical archive
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

The bundle is not stored in Git, and there is currently no repository command
to download that exact snapshot. A new clone can install frontend dependencies,
run unit tests and build both frontends without it; native route calculation
and engine benchmarks require the separate bundle. Do not upload the large
maps, runtime archives or private benchmark output to the source repository.

From the checkout, install runtimes and build the engine integration:

```sh
node scripts/setup-native.mjs
export PATH="$PWD/.cache/runtime/node/bin:$PATH"
npm ci
npm run bench:brouter:performance
npm run routing:build
npm run dev:local
```

`native:setup` downloads checksum-verified Node and GraalVM archives into
`.cache/runtime/`. It is specific to Linux x64. `.nvmrc` records the Node version
for other development environments. Use an existing Node 22 or newer
to run the installer. In the prepared workspace, the equivalent bootstrap is
`../richiroute-ubuntu-benchmark/runtime/node/bin/node scripts/setup-native.mjs`.
Subsequent app commands use the new runtime.

The repository launcher, `scripts/start-local.sh`, verifies the original bundle
and the separately built rules integration. It prepares the shared local rules
and their profile, then starts GraalVM Community 25.4.4.1.1 with its default compiler, a 1 GB heap,
the parallel collector and six routing workers. It binds BRouter to
`127.0.0.1:17777` and Vite to `127.0.0.1:5173`. Ctrl+C stops both child processes.
The log is `experiments/routing/.local/native-brouter.log`. Docker, GraphHopper
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
the service activates new locations without rebuilding Java. The preparation
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
`npm ci` succeeded. A fresh `npm audit --package-lock-only --ignore-scripts`
on 23 October reported **zero vulnerabilities** for the committed npm lockfile.
GitHub reported 29 dependency alerts during the push. That separate warning
has not been confirmed resolved. Check the repository's
[dependency alerts](https://github.com/adamn676/richi-route/security/dependabot)
and run `npm audit` and `npm outdated` when changing dependencies.
The last version review found only the deliberate TypeScript major-version hold:

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
not need changing. Optional GraphHopper, ORS and Photon are not installed in the
native workspace.

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

The editor sends `profile:pass1coefficient=2` and `profile:pass2coefficient=0.7`
from `src/config/routing-search.json` to guide the initial search and refinement.
The comparison preset `local-rules-v1` uses those settings and the shared rules.
The historical preset `weidweg-search-v3` retains its earlier profile and Thal
preference. Presets `weidweg-search-v1` and `weidweg-search-v2`
retain the earlier refinement-only settings `0.5` and `0.7`. Search parameters
apply per request; a changed routing policy recalculates cached legs. See the
[latest initial-route measurements](../experiments/routing/README.md#runtime-and-search-optimization-22-october-2026).

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
| BRouter | 17777 | Planner route calculation |
| GraphHopper | 8989 | Comparison routing and local road tiles |
| openrouteservice, optional | 8082 | Third comparison engine |
| Photon, optional | 2322 | Address search |

Photon is not installed by these scripts. Map placement and routing work without
it. Street and aerial backgrounds use online basemap.at tiles. Published service
ports bind to `127.0.0.1`.

## Route storage and export

The planner saves one draft in browser storage for `http://127.0.0.1:5173/`,
including calculated geometry, points, surfaces and elevation. Reopening restores
completed legs without recalculating them; interrupted work resumes when routing
is available. Undo history is limited to the current session.

A second tab pauses draft saving when another tab changes it.

**Meine Routen** stores named routes in IndexedDB. The list loads only route
metadata; geometry is read when opening, duplicating or exporting a route.
**Route speichern** adds an entry. After opening it, **Änderungen speichern**
updates that entry, while **Als Kopie speichern** creates a separate one. Entries
can also be renamed, duplicated or deleted. Reloading restores the draft; open
its saved entry again before updating that entry.

Opening another route, starting **Neue Route**, or loading an example first saves
a changed draft as an **Entwurf** entry. If saving fails or the editor changes
during that save, the switch stops and the current route stays open. Saving or
deleting an entry checks its revision inside the same database transaction, so
an outdated tab cannot silently overwrite another tab's changes. Deleting a
saved entry leaves its currently open draft intact.

**Sicherung herunterladen** exports the current editable route, including its
points, geometry, elevation, surfaces and routing revision, as `.richiroute.json`.
**Sicherung importieren** validates that format and adds a new entry without
replacing the current draft or existing entries. Imports are limited to 64 MB.
This imports RichiRoute backups, not GPX files. Changed routing rules still cause
recalculation when opening a saved route, keeping its old geometry visible.

Clearing browser data removes both the draft and saved routes. The collection
uses asynchronous IndexedDB storage; draft autosaving still uses localStorage
and can reach its smaller quota. Named saves and backup downloads remain usable
when draft autosaving fails. Storage is specific to the browser and site origin.

**GPX herunterladen** exports the calculated track and known elevation once all
points and legs are ready. Dashed placeholder legs cannot be exported, and small
gaps stay separate track segments. Export uses GPX 1.1 without device-specific
turn instructions. Physical cycling-computer imports have not been tested.

## Import a GPX reference

**GPX importieren** reads GPX 1.0 and 1.1 tracks locally and displays them as a
separate reference layer. Importing leaves the editable route, its undo history,
saved routes and GPX export unchanged. It sends no routing requests. Use
**Track zeigen** to fit the reference, **Track einblenden** to toggle it, and
**Track entfernen** to remove it. A successful import replaces the previous
reference; an invalid file leaves it intact.

All tracks and nonempty track segments in the file are retained separately.
Single-point segments appear as dots. Distance is calculated along each segment,
without adding connections across gaps. Missing elevation remains unknown;
ascent is shown only when all elevations are present and is summed without
smoothing. The small elevation chart reduces display samples for long tracks,
while stored coordinates, elevations and the map source retain every point.
Date-line crossings shift display longitudes by whole worlds without changing
the imported coordinates.

Arrows follow the recorded point order. Each segment has **S** and **Z** markers
for its start and finish. A closed segment or single point uses **S/Z**. Move
across the elevation profile with a mouse or finger to show that position on the
map. The slider also supports keyboard input. The readout shows distance,
available elevation, estimated gradient and segment number. Crossing a segment
boundary jumps to the next segment without inventing a connecting line.

**Trackfarbe** offers a plain line, elevation bands relative to the track's
minimum and maximum, or fixed gradient bands. Each colour mode has a legend;
grey means unknown. Gradients use a roughly 50 m window within continuous
elevation data. Sparse points can extend that window; spans shorter than 10 m
have no gradient estimate. These are estimates from the file's heights, so noisy
recordings can still distort them. Colour sections use at least 50 m, increasing
for very long tracks to limit rendering work, while preserving all vertices.
Profile movement updates only the map dot, without rebuilding the track.
Road materials are not inferred from a GPX track; matching them to map data is
not implemented.

The reference lasts for the current page session and is not included in saved
routes or RichiRoute backups. Reimport the original GPX after reloading. Editable
conversion is not implemented. Files containing only route points or waypoints
are rejected with an explanation because they do not supply a track geometry.
Time, extension and waypoint fields are not displayed. Limits are 32 MB and
250,000 trackpoints per file. Malformed XML, invalid coordinates or elevations,
unsupported versions and document-type declarations are rejected.

Run `node tests/browser-gpx-import.mjs` against the frontend to check XML parsing,
long tracks, partial elevation, segment boundaries, cancellation and unchanged
editor data. It uses synthetic GPX data and does not need a routing engine;
`ROUTE_TEST_ORIGIN` selects a different frontend port. Screenshots and a report
go to `.cache/gpx-import/`.

Run `node tests/browser-gpx-inspection.mjs` to check direction markers, colour
modes, mouse, keyboard and touch inspection, missing elevations, style changes
and a 50,000-point track. It also checks that moving across the profile does not
resend full track geometry. Screenshots and results go to `.cache/gpx-inspection/`.

## Inspect route surfaces

After a route finishes calculating, open **Beläge prüfen** below the colour
legend. Select a material to see its sections and distance along the route.
Select a section to frame and highlight it on the map. **Weitere Abschnitte**
shows ten more entries; **Markierung aufheben** removes the highlight.

The inspector distinguishes materials such as fine gravel, wood and paving
stones. Missing surface tags stay unknown. Lengths follow the drawn coordinates
and can differ slightly from the routing engine's reported total. Material tags
describe the map data; they do not establish the current condition of a road.

Inspection does not change the route, undo history or saved draft. Edits and
undo/redo clear the highlight. Older drafts still load without rerouting and
display the broader groups originally saved. New calculations retain individual
material tags. The [long-route review](../experiments/routing/README.md#long-route-surface-review-22-october-2026)
records the surface-penalty experiments and why the default remains unchanged.

## Checks

The [Checks workflow](../.github/workflows/checks.yml) runs on pushes to `main`
and pull requests, and can also be started manually in GitHub Actions. It uses
the Node version in `.nvmrc` and the npm version in `package.json`, performs
`npm ci`, then runs both unit-test suites and both production builds, including
TypeScript checks. Native engine, live routing and browser checks remain local
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
for `/routing`, optional `/geocoding`, and `/tiles`. The comparison also needs its
development API or a replacement server. There is no deployment configuration in
this repository.

Engine comparisons, profile history and map-data limitations are documented in
the [routing guide](../experiments/routing/README.md).

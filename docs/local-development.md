# Local development

Run commands from the repository root. The current setup has been checked on
Windows with Node.js 22.21 and Docker Desktop using Linux containers. Linux
also needs `unzip` for the BRouter archive. In PowerShell, use `npm.cmd` if
execution policy blocks `npm`.

## First installation

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

The BRouter patch build uses the compiler in the local ORS image. Building that
image does not start the ORS service. The build also creates the editor's
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
installation can skip these setup steps. The editor also applies the local road
preference recorded in `src/config/thal-preference.json`.

When updating an existing installation, stop BRouter before rebuilding the patch
on Windows so its JAR is not locked. Start it again with `npm run bench:up`.

## Start and stop

```sh
npm run bench:up
npm run dev
```

Open **http://127.0.0.1:5173/** for the planner. The first GraphHopper start imports
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

On Ubuntu, keep the repository and routing data on a Linux filesystem. Native
Ubuntu performance has not been measured on this machine; Windows with
container-local data already provides the measured storage improvement.

In another terminal, start the comparison app if needed:

```sh
npm run bench:dev
```

Open **http://127.0.0.1:5174/**. BRouter and GraphHopper run locally; ORS is optional:

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

Clearing browser data removes the draft. A second tab pauses saving when another
tab changes it. **Neue Route** replaces the current draft with an empty route.

**GPX herunterladen** exports the calculated track and known elevation once all
points and legs are ready. Dashed placeholder legs cannot be exported, and small
gaps stay separate track segments. Export uses GPX 1.1 without device-specific
turn instructions. Physical cycling-computer imports have not been tested.

## Checks

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
as a separate target using the editor's `weidweg-local-v1` settings. The passage
check also verifies both directions and opt-out behaviour. Requests, responses
and reports stay in the ignored `.local/`
directory. Do not replace expected geometry just to make a failing check pass.
Fresh map downloads can differ from the data used for the saved reviews.

With the planner server also running:

```sh
npm run test:editor-local
```

This exercises the same protected routes through the editor and checks that local
edits preserve distant legs. Browser scripts in `tests/` additionally require
Chrome and the local Playwright installation at `.cache/browser-tools/`; that
installation is not supplied by `npm ci`. Their screenshots and reports are ignored.

`node tests/browser-long-routes.mjs` builds Graz–Virgen across two map tiles
(339 km), a 252 km single leg and a 242 km loop in isolated browser contexts.
It checks drawing, all exported coordinates and elevations, saved reload,
local editing and undo without changing your draft.

## Builds and deployment

`npm run build` creates the planner in `dist/`. `npm run bench:build` creates the
comparison app in `experiments/routing/dist/`.

The development servers proxy requests to local engines. Serving the built files
alone does not provide routing: a deployment needs equivalent same-origin proxies
for `/routing`, optional `/geocoding`, and `/tiles`. The comparison also needs its
development API or a replacement server. There is no deployment configuration in
this repository.

Engine comparisons, profile history and map-data limitations are documented in
the [routing guide](../experiments/routing/README.md).

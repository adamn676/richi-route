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
extract and the BRouter regional tile into `experiments/routing/.local/`.
Docker images are separate downloads. Existing files are checked against recorded
hashes; a mismatch stops setup rather than replacing the data.

The BRouter patch build uses the compiler in the local ORS image. Building that
image does not start the ORS service. The patch applies a specific bicycle-turn
correction; see its [scope and checks](../experiments/routing/brouter-patch/README.md).

Create the editor's road-cycling profile once on a fresh installation:

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
```

This protects 14 reviewed route variants and reports the western-loop composite
as a separate target. Requests, responses and reports stay in the ignored `.local/`
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

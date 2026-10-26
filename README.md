# RichiRoute

A road-cycling route planner for choosing the roads you want to ride.

Place your stops, drag the route onto a preferred road, inspect the elevation and
road surfaces, then export a GPX track. Editing one part of the route keeps the
unaffected sections in place.

RichiRoute is in active development, with routing tested around Graz and Styria,
Austria. The planner currently has a German interface.

## What it does

- Get three loop suggestions from your start for a distance and climbing target, inspect each with its profile and surfaces, and keep one as an editable route.
- Plan routes with multiple stops and shaping points, including loops and return trips; stops set on the map show their street.
- Drag points or route sections, with undo and redo.
- Inspect distance, ascent, elevation and surface types along the route.
- Highlight individual surface sections on the map.
- Choose the local map, which colours roads for cycling, or an aerial view with street names; add shaded relief, or switch to OpenTopoMap online.
- Switch on cycle paths, signed cycle routes, drinking-water sources, bicycle services, food stops and railway stations over any map.
- Look at Google Street View from any point on the map or the elevation profile.
- Save, reopen, rename and duplicate routes in a local route collection.
- Back up editable routes as RichiRoute files and download calculated tracks as GPX.
- Import GPX tracks to compare, with direction arrows, a linked elevation profile, and height or gradient colours, or open them as an editable route.
- Estimate GPX surface materials on demand, with unknown sections kept separate.

Routing uses a local BRouter engine with a road-cycling profile. It prefers paved
roads, but unpaved sections can still occur. Missing surface information remains
marked as unknown.

## Run locally

The current planner uses Node.js 26.12.1, npm 12.2.1 and a local BRouter engine
with shared routing rules. The native launcher supports Linux x64. Its verified
engine, profiles and regional map tiles come from the separate
`richiroute-ubuntu-benchmark/` bundle, placed next to this checkout. That bundle
is required for routing and is not included in Git. The repository does not
currently provide an automated download of that exact reviewed bundle.

Follow the [native setup guide](docs/local-development.md#native-linux-setup)
before starting the planner:

```sh
npm run dev:local
```

Open **http://127.0.0.1:5173/**. Click the map to place a start and destination,
then drag the route to choose different roads (on a phone, hold it briefly first). Ctrl+C stops the planner,
routing engine, search and map services. The launcher is included in `scripts/start-local.sh`.

Without the routing bundle, the frontend and unit tests can still be built
from a clone with the required Node version:

```sh
npm ci
npm test
npm run bench:test
npm run build
npm run bench:build
```

`npm run dev` starts only the frontend. Live route calculation needs the prepared
native service. The Docker configuration under `experiments/routing/` preserves
an earlier comparison engine and does not serve the current planner's profile.

Route calculation, European street maps and European address search run locally
once their datasets are installed. Run `npm run search:setup` and
`npm run maps:setup`, `npm run terrain:setup` and `npm run imagery:setup` before the first `npm run dev:local`; the initial downloads
are large. See [local development](docs/local-development.md#european-map-data)
for storage, coverage and update instructions. Search has no automatic public
fallback. The aerial view combines a local European Sentinel overview with
detailed photographs in Austria, Switzerland and France, with regional detail
from Graz and Styria. Dense screens request finer imagery where available.
New detail imagery needs internet; cached tiles and explicitly saved areas work offline. See
[imagery and offline areas](docs/local-development.md#european-imagery).
European map coverage does not extend BRouter's installed routing coverage.
The map selector also offers **OpenTopoMap** (contour lines) online, local
**Geländerelief** (shaded relief) as a layer, and signed cycle routes from
Waymarked Trails under **Rad-Infos**. The online sources need no account or API
key and are contacted only when selected; the local maps remain the default. See
[map choices](docs/local-development.md#online-map-choices).
Street View links open Google Maps in a new tab; with an optional Google Maps
Embed API key in the git-ignored `.env.local`, Street View shows inside the
planner. See [Street View setup](docs/local-development.md#inspect-the-route-elevation-profile).
Water, bicycle-service and railway-station overlays use a separate local OSM extract. Their
installed coverage and data date appear under **Rad-Infos**; the initial extract
covers Austria. See [cycling overlays](docs/local-development.md#cycling-overlays)
for setup and updates.

## Routing development

Local passage exceptions, bicycle turns and avoidance preferences live in
[`config/routing-rules.json`](config/routing-rules.json). The engine and browser
use this shared configuration. New locations of supported types need a data
update and service restart. See the [rule workflow](docs/local-development.md#managing-local-routing-rules).

A separate comparison app shows BRouter, GraphHopper and optional local
openrouteservice routes, with elevation and surface details where available.
With its separate engines and data prepared, start it with `npm run bench:dev`
and open **http://127.0.0.1:5174/**.

Rider-reviewed routes are kept as regression fixtures to check that profile
changes preserve accepted routes.

See the [routing guide](experiments/routing/README.md) for comparisons, review
evidence and profile changes, or the [development checks](docs/local-development.md#checks)
for test commands.

The repository keeps source, routing configuration, tests, reviewed fixtures
and dependency versions. Downloaded runtimes, map data, build output, browser
drafts, logs and local benchmark recordings stay outside version control.

## Project scope

The current setup runs locally and uses regional map data. It does not provide
accounts, cloud sync or a hosted service. Browser storage holds the current draft
and a named route collection. Download RichiRoute backups to keep editable copies
outside the browser; clearing browser data removes locally stored routes.

Built with Vue 3, Vuetify (Material Design 3), TypeScript, Pinia and MapLibre GL JS. Routing data comes from
OpenStreetMap. The planner serves its own [Protomaps](https://protomaps.com/)
vector tiles, fonts and symbols. Photon supplies local address search. Imagery
comes from Copernicus Sentinel, basemap.at, swisstopo and IGN, with attribution
on the map. The historical comparison map still uses basemap.at.

# RichiRoute

A road-cycling route planner for choosing the roads you want to ride.

Place your stops, drag the route onto a preferred road, inspect the elevation and
road surfaces, then export a GPX track. Editing one part of the route keeps the
unaffected sections in place.

RichiRoute is in active development, with routing tested around Graz and Styria,
Austria. The planner currently has a German interface.

## What it does

- Plan routes with multiple stops and shaping points, including loops and return trips.
- Drag points or route sections, with undo and redo.
- Inspect distance, ascent, elevation and surface types along the route.
- Highlight individual surface sections on the map.
- Switch between street maps, aerial imagery with street names, and a local road map.
- Save, reopen, rename and duplicate routes in a local route collection.
- Back up editable routes as RichiRoute files and download calculated tracks as GPX.

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
then drag the route to choose different roads. Ctrl+C stops the planner and
routing engine. The launcher is included in `scripts/start-local.sh`.

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

Route calculation stays on your computer. Street maps and aerial imagery need
an internet connection. The local road map needs the optional GraphHopper
comparison service. Address search needs a separate local Photon service.

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

Built with Vue 3, TypeScript, Pinia and MapLibre GL JS. Routing data comes from
OpenStreetMap; street maps and aerial imagery come from basemap.at. Provider
attribution is displayed on the map.

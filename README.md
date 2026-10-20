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
- Switch between street maps, aerial imagery with street names, and a local road map.
- Restore the current route from browser storage and download it as GPX.

Routing uses a local BRouter engine with a road-cycling profile. It prefers paved
roads, but unpaved sections can still occur. Missing surface information remains
marked as unknown.

## Run locally

You need Node.js, Docker with Linux containers, and the regional routing data.
Follow the [local setup guide](docs/local-development.md) on a new installation.
Routing engines and map data are downloaded separately from this repository.

Once setup is complete, start Docker and run:

```sh
npm run bench:up
npm run dev
```

Open **http://127.0.0.1:5173/**. Click the map to place a start and destination,
then drag the route to choose different roads. On Windows PowerShell, use
`npm.cmd` if script execution policy prevents `npm` from running.

Route calculation stays on your computer. Street maps and aerial imagery need
an internet connection; the local road map works with the prepared routing data.
Address search is optional and requires a separate local Photon service.

## Routing development

A separate comparison app shows BRouter, GraphHopper and optional local
openrouteservice routes, with elevation and surface details where available.
Start it with `npm run bench:dev` and open **http://127.0.0.1:5174/**.

Rider-reviewed routes are kept as regression fixtures to check that profile
changes preserve accepted routes.

See the [routing guide](experiments/routing/README.md) for comparisons, review
evidence and profile changes, or the [development checks](docs/local-development.md#checks)
for test commands.

## Project scope

The current setup runs locally and uses regional map data. It does not provide
accounts, cloud sync or a hosted service. Browser storage holds one current
route; export GPX files to keep tracks separately.

Built with Vue 3, TypeScript, Pinia and MapLibre GL JS. Routing data comes from
OpenStreetMap; street maps and aerial imagery come from basemap.at. Provider
attribution is displayed on the map.
